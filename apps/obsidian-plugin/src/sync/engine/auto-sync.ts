import type { SyncTokenResponse } from "../remote/client";
import {
  isRemoteVaultUnavailableError,
  remoteVaultUnavailableFromWebSocketClose,
  type RemoteVaultUnavailableError,
} from "../../remote-vault/unavailable";
import type { PullOnceResult } from "./pull-service";
import type { PushPendingMutationsResult } from "./push-service";
import {
  SyncRealtimeClient,
  SyncRealtimeConnectionError,
  SyncRealtimeError,
  type SyncRealtimeSession,
  type SyncStorageStatus,
} from "../remote/realtime-client";
import type { SyncCursorStore } from "../store/ports";
import { SyncAutoLoopState, type SyncConnectionState } from "./auto-sync-state";
import { AutoSyncTimers } from "./auto-sync-timers";
import { PendingSyncWorkQueue } from "./auto-sync-work-queue";

const DEFAULT_PUSH_DEBOUNCE_MS = 300;
const DEFAULT_RECONNECT_DELAY_MS = 3_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;
const DEFAULT_SYNC_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_SYNC_RETRY_MAX_DELAY_MS = 30_000;

export interface SyncAutoLoopDeps {
  getApiBaseUrl: () => string;
  getSyncToken: () => Promise<SyncTokenResponse>;
  getSyncStore: () => SyncCursorStore | null;
  pushPendingMutations: (
    session: SyncRealtimeSession,
  ) => Promise<PushPendingMutationsResult>;
  unblockFileSizeBlockedMutations?: (
    session: SyncRealtimeSession,
  ) => Promise<number>;
  /**
   * Whether the store holds changes waiting to be pushed. Asked when a
   * session opens, because the in-memory request for a push does not survive
   * `stop()`.
   */
  hasPendingMutations?: () => Promise<boolean>;
  /**
   * Resolves with what the pull applied. `void` means "not reported", which
   * is treated as progress so a caller that does not count never backs off.
   */
  pullOnce: (session: SyncRealtimeSession) => Promise<PullOnceResult | void>;
  realtimeClient?: SyncRealtimeClientLike;
  pushDebounceMs?: number;
  reconnectDelayMs?: number;
  reconnectMaxDelayMs?: number;
  syncRetryBaseDelayMs?: number;
  syncRetryMaxDelayMs?: number;
  onConnectionStateChange?: (state: SyncConnectionState) => void;
  onStorageStatusChange?: (status: SyncStorageStatus | null) => void;
  onSyncScheduled?: () => void;
  onIdle?: () => void;
  onError?: (error: unknown) => void;
  onRemoteVaultUnavailable?: (error: RemoteVaultUnavailableError) => void | Promise<void>;
  onStorageQuotaExceeded?: () => void | Promise<void>;
}

export interface SyncRealtimeClientLike {
  openSession: SyncRealtimeClient["openSession"];
}

export class SyncAutoLoop {
  private readonly realtimeClient: SyncRealtimeClientLike;
  private realtimeSession: SyncRealtimeSession | null = null;
  private connectPromise: Promise<void> | null = null;
  private drainPromise: Promise<void> | null = null;
  private readonly timers = new AutoSyncTimers();
  private reconnectAttempt = 0;
  private syncRetryAttempt = 0;
  /**
   * Whether the armed sync retry was earned by a push that failed or went
   * nowhere. Only then is a requested push held until it ends: a backoff a
   * failing pull started says nothing about whether a push would land.
   */
  private syncRetryHoldsPush = false;
  private readonly state: SyncAutoLoopState;
  private storageStatusWatching = false;
  private readonly pendingWork = new PendingSyncWorkQueue();

  constructor(private readonly deps: SyncAutoLoopDeps) {
    this.realtimeClient = deps.realtimeClient ?? new SyncRealtimeClient();
    this.state = new SyncAutoLoopState(deps.onConnectionStateChange);
  }

  async start(): Promise<boolean> {
    if (this.isActive()) {
      return false;
    }

    this.state.set("live");
    await this.ensureRealtimeSession();
    return true;
  }

  stop(): void {
    this.state.set("stopped");
    this.pendingWork.clear();
    this.timers.clearAll();
    this.syncRetryHoldsPush = false;
    this.realtimeSession?.close();
    this.realtimeSession = null;
  }

  notifyLocalChange(): void {
    if (!this.isActive()) {
      return;
    }

    this.deps.onSyncScheduled?.();
    this.timers.set("push", () => {
      this.requestPush();
      void this.drain();
    }, this.deps.pushDebounceMs ?? DEFAULT_PUSH_DEBOUNCE_MS);
  }

  requestPull(targetCursor: number | null = null): void {
    if (!this.isActive()) {
      return;
    }

    this.deps.onSyncScheduled?.();
    this.requestPullWork(targetCursor);
    void this.drain();
  }

  setStorageStatusWatching(enabled: boolean): void {
    if (this.storageStatusWatching === enabled) {
      return;
    }

    this.storageStatusWatching = enabled;
    if (!enabled) {
      this.deps.onStorageStatusChange?.(null);
    }
    this.applyStorageStatusWatch();
  }

  async ensureRealtimeSession(): Promise<void> {
    if (!this.isActive() || this.realtimeSession || this.connectPromise) {
      return await (this.connectPromise ?? Promise.resolve());
    }

    this.connectPromise = this.openRealtimeSession();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async withRealtimeSession<T>(
    work: (session: SyncRealtimeSession) => Promise<T>,
  ): Promise<T> {
    if (!this.isActive()) {
      this.state.set("live");
    }

    await this.ensureRealtimeSession();
    const session = this.realtimeSession;
    if (!session) {
      throw new Error("Sync realtime session is not connected.");
    }

    return await work(session);
  }

  reconnectNow(): void {
    if (!this.isActive()) {
      return;
    }

    this.timers.clear("reconnect");
    this.markRealtimeDisconnected(false);
    void this.ensureRealtimeSession();
  }

  async resumeConnection(): Promise<void> {
    if (!this.isActive() || this.realtimeSession) {
      return;
    }

    this.timers.clear("reconnect");
    await this.ensureRealtimeSession();
  }

  private async openRealtimeSession(): Promise<void> {
    try {
      this.state.set("connecting");
      const store = this.deps.getSyncStore();
      if (!store) {
        throw new Error("Sync store is not initialized.");
      }

      const token = await this.deps.getSyncToken();
      const cursor = await store.getCursor();
      const session = await this.realtimeClient.openSession(
        this.deps.getApiBaseUrl(),
        token,
        cursor,
        {
          onCursorAdvanced: (nextCursor) => {
            this.requestPull(nextCursor);
          },
          onStorageStatusUpdated: (status) => {
            this.deps.onStorageStatusChange?.(status);
          },
          onPolicyUpdated: (_policy, storageStatus) => {
            void this.handlePolicyUpdated(storageStatus);
          },
          onClose: (event) => {
            const unavailable = remoteVaultUnavailableFromWebSocketClose(
              event,
              token.vaultId,
            );
            if (unavailable) {
              this.handleRemoteVaultUnavailable(unavailable);
              return;
            }

            this.markRealtimeDisconnected();
          },
          onError: (error) => {
            if (
              !isRealtimeConnectionError(error) &&
              !isCursorAheadOfServerError(error)
            ) {
              this.handleError(error);
            }
          },
        },
      );
      if (!this.isActive()) {
        session.close();
        return;
      }

      this.realtimeSession = session;
      try {
        if (cursor > session.serverCursor) {
          throw new SyncRealtimeError(
            "cursor_ahead_of_server",
            "Sync was paused because this device's sync history no longer matches the remote vault. To resume syncing, disconnect and reconnect the remote vault in Syncali settings.",
          );
        }
        this.reconnectAttempt = 0;
        if (this.storageStatusWatching) {
          this.applyStorageStatusWatch();
        }
        const unblockedFileSizeMutations =
          (await this.deps.unblockFileSizeBlockedMutations?.(session)) ?? 0;
        // The store, not the in-memory queue, says whether anything is
        // waiting. stop() empties the queue, so a push that was held behind a
        // backoff when sync stopped would otherwise be lost, and the session
        // reported idle over an edit that never left this device.
        if (
          unblockedFileSizeMutations > 0 ||
          (await this.deps.hasPendingMutations?.())
        ) {
          this.deps.onSyncScheduled?.();
          this.requestPush();
        }
        if (session.serverCursor > cursor) {
          this.deps.onSyncScheduled?.();
          this.requestPullWork(session.serverCursor);
        }
        this.state.set("live");
        // A new session is a change of circumstances, so whatever was
        // waiting out a backoff from the old one gets its chance now rather
        // than when the old timer ends.
        this.resetSyncRetry();
        if (this.hasPendingWork()) {
          void this.drain();
        } else {
          this.deps.onIdle?.();
        }
      } catch (error) {
        if (this.realtimeSession === session) {
          this.realtimeSession = null;
        }
        session.close();
        throw error;
      }
    } catch (error) {
      if (isCursorAheadOfServerError(error)) {
        this.stop();
        this.handleError(error);
        return;
      }

      if (isRemoteVaultUnavailableError(error)) {
        this.handleRemoteVaultUnavailable(error);
        return;
      }

      if (!isRealtimeConnectionError(error)) {
        this.handleError(error);
      }
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.isActive() || this.timers.has("reconnect")) {
      return;
    }

    this.state.set("reconnect_wait");
    const baseDelay = this.deps.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    const maxDelay = this.deps.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
    const delay = Math.min(baseDelay * 2 ** this.reconnectAttempt, maxDelay);
    this.reconnectAttempt += 1;
    this.timers.set("reconnect", () => {
      void this.ensureRealtimeSession();
    }, delay);
  }

  private markRealtimeDisconnected(scheduleReconnect = true): void {
    if (!this.isActive()) {
      return;
    }

    const session = this.realtimeSession;
    this.realtimeSession = null;
    this.deps.onStorageStatusChange?.(null);
    session?.close();
    if (scheduleReconnect) {
      this.scheduleReconnect();
    }
  }

  private async handlePolicyUpdated(storageStatus: SyncStorageStatus): Promise<void> {
    if (!this.isActive()) {
      return;
    }

    if (this.storageStatusWatching) {
      this.deps.onStorageStatusChange?.(storageStatus);
    }

    const session = this.realtimeSession;
    if (!session) {
      return;
    }

    try {
      const unblockedFileSizeMutations =
        (await this.deps.unblockFileSizeBlockedMutations?.(session)) ?? 0;
      if (unblockedFileSizeMutations > 0) {
        this.deps.onSyncScheduled?.();
        this.requestPush();
        void this.drain();
      }
    } catch (error) {
      if (!isRealtimeConnectionError(error)) {
        this.handleError(error);
      }
    }
  }

  private applyStorageStatusWatch(): void {
    const session = this.realtimeSession;
    if (!session) {
      return;
    }

    try {
      if (this.storageStatusWatching) {
        session.watchStorageStatus();
        this.deps.onStorageStatusChange?.({
          storageUsedBytes: session.storageUsedBytes,
          storageLimitBytes: session.storageLimitBytes,
        });
      } else {
        session.unwatchStorageStatus();
      }
    } catch (error) {
      if (!isRealtimeConnectionError(error)) {
        this.handleError(error);
      }
    }
  }

  private async drain(): Promise<void> {
    if (!this.isActive() || this.drainPromise) {
      return await (this.drainPromise ?? Promise.resolve());
    }
    this.drainPromise = this.runDrainLoop();
    try {
      await this.drainPromise;
    } finally {
      this.drainPromise = null;
      if (
        this.isActive() &&
        this.hasPendingWork() &&
        !this.timers.has("reconnect") &&
        !this.timers.has("syncRetry")
      ) {
        void this.drain();
      }
    }

    if (
      this.isActive() &&
      !this.hasPendingWork() &&
      !this.timers.has("reconnect") &&
      !this.timers.has("syncRetry")
    ) {
      this.state.set("live");
      this.deps.onIdle?.();
    }
  }

  private async runDrainLoop(): Promise<void> {
    this.state.set("draining");
    while (this.isActive() && this.hasRunnableWork()) {
      // A push waiting out a backoff stays waiting until the backoff ends.
      // Pulls still run - another device's changes should arrive whatever
      // this device is stuck on - but a pull used to take the waiting push
      // with it, and when another device was busy that ran a stalled push
      // about once a second, which is the loop the backoff is there to stop.
      const holdPush = this.isPushHeld();
      const work = this.takePendingWork(holdPush);
      const shouldPush = work.push;
      const shouldPull = work.pullTargetCursor !== null;

      let shouldPullNow = shouldPull;
      let pushCompleted = !shouldPush;
      let pushResult: PushPendingMutationsResult | null = null;
      let pullAfterPush: PullOnceResult | void = undefined;
      try {
        let session: SyncRealtimeSession | null = null;
        if (shouldPush || shouldPullNow) {
          await this.ensureRealtimeSession();
          session = this.realtimeSession;
          if (!session) {
            if (shouldPush) {
              this.requestPush();
            }
            if (shouldPullNow) {
              this.requestPullWork(work.pullTargetCursor);
            }
            if (!this.timers.has("reconnect")) {
              this.scheduleSyncRetry();
            }
            return;
          }
        }

        if (shouldPullNow) {
          if (!session) {
            throw new Error("Sync realtime session is not connected.");
          }
          await this.deps.pullOnce(session);
          shouldPullNow = false;
        }
        if (shouldPush) {
          if (!session) {
            throw new Error("Sync realtime session is not connected.");
          }
          pushResult = await this.deps.pushPendingMutations(session);
          pushCompleted = true;
          if (pushResult.stopReason === "storage_quota_exceeded") {
            try {
              await this.deps.onStorageQuotaExceeded?.();
            } finally {
              this.stop();
            }
            return;
          }
          shouldPullNow = shouldPullNow || pushResult.shouldPullAfterPush;
          if (pushResult.hasMore) {
            this.requestPush();
          }
        }
        if (shouldPullNow) {
          if (!session) {
            throw new Error("Sync realtime session is not connected.");
          }
          pullAfterPush = await this.deps.pullOnce(session);
        }
        // One file's upload failed in a way worth retrying, and the rest of
        // its batch went through. Retrying at once would upload that file
        // again straight away, so it waits on the backoff like any other
        // failure, and is reported like one.
        if (pushResult?.retryLater) {
          this.handleError(pushResult.retryLater.error);
          this.scheduleSyncRetry({ holdsPush: true });
          return;
        }
        // A pass that changed nothing will change nothing if it runs again
        // straight away. Looping here is what turned one stuck note into an
        // upload a second: the push was told to pull first, the pull had
        // nothing for it, and the push tried again at once. Whatever the cause
        // turns out to be next time, waiting on the ordinary backoff turns
        // that into one attempt per backoff step instead.
        if (pushResult && isStalledPass(pushResult, pullAfterPush)) {
          this.scheduleSyncRetry({ holdsPush: true });
          return;
        }
        // A pull that ran while the push waited says nothing about whether
        // the push would now succeed, so the backoff carries on. A backoff
        // only a pull earned never holds the push, so it ends here.
        if (!holdPush) {
          this.resetSyncRetry();
        }
      } catch (error) {
        if (isCursorAheadOfServerError(error)) {
          this.stop();
          this.handleError(error);
          return;
        }

        if (isRemoteVaultUnavailableError(error)) {
          this.handleRemoteVaultUnavailable(error);
          return;
        }

        if (shouldPush && !pushCompleted) {
          this.requestPush();
        }
        if (shouldPullNow) {
          this.requestPullWork(work.pullTargetCursor);
        }
        if (!isRealtimeConnectionError(error)) {
          this.handleError(error);
        }
        this.scheduleSyncRetry({ holdsPush: shouldPush && !pushCompleted });
        return;
      }
    }

    if (this.isActive() && this.isPushHeld()) {
      this.state.set("retry_wait");
    }
  }

  private isPushHeld(): boolean {
    return (
      this.syncRetryHoldsPush && this.timers.has("syncRetry") && this.pendingWork.push
    );
  }

  private scheduleSyncRetry(options: { holdsPush?: boolean } = {}): void {
    if (!this.isActive()) {
      return;
    }
    if (options.holdsPush) {
      this.syncRetryHoldsPush = true;
    }
    if (this.timers.has("syncRetry")) {
      return;
    }

    this.state.set("retry_wait");
    const baseDelay = this.deps.syncRetryBaseDelayMs ?? DEFAULT_SYNC_RETRY_BASE_DELAY_MS;
    const maxDelay = this.deps.syncRetryMaxDelayMs ?? DEFAULT_SYNC_RETRY_MAX_DELAY_MS;
    const delay = Math.min(baseDelay * 2 ** this.syncRetryAttempt, maxDelay);
    this.syncRetryAttempt += 1;
    this.timers.set("syncRetry", () => {
      this.syncRetryHoldsPush = false;
      if (!this.isActive()) {
        return;
      }

      // Nothing left to retry: whatever failed has since been done, dropped or
      // superseded. Returning here left the engine parked in retry_wait with
      // no work and no path back - idle is only ever reported at the end of a
      // drain, and no drain was coming. The status span reported "syncing"
      // forever over a vault that was completely up to date, with no network
      // traffic and nothing being written.
      if (!this.hasPendingWork()) {
        this.resetSyncRetry();
        this.state.set("live");
        this.deps.onIdle?.();
        return;
      }

      this.deps.onSyncScheduled?.();
      void this.drain();
    }, delay);
  }

  private resetSyncRetry(): void {
    this.syncRetryAttempt = 0;
    this.syncRetryHoldsPush = false;
    this.timers.clear("syncRetry");
  }

  private isActive(): boolean {
    return this.state.isActive();
  }

  private requestPush(): void {
    this.pendingWork.requestPush();
  }

  private requestPullWork(targetCursor: number | null): void {
    this.pendingWork.requestPull(targetCursor);
  }

  private hasPendingWork(): boolean {
    return this.pendingWork.hasPendingWork();
  }

  private hasRunnableWork(): boolean {
    return this.pendingWork.hasRunnableWork({ holdPush: this.isPushHeld() });
  }

  private takePendingWork(holdPush: boolean) {
    return this.pendingWork.takePendingWork({ holdPush });
  }

  private handleError(error: unknown): void {
    this.deps.onError?.(error);
  }

  private handleRemoteVaultUnavailable(error: RemoteVaultUnavailableError): void {
    this.stop();
    void this.deps.onRemoteVaultUnavailable?.(error);
  }
}

/**
 * Whether a push-then-pull pass made no progress at all: nothing accepted,
 * nothing settled as a conflict, something sent back to the queue, and the
 * pull that the push asked for applied nothing.
 */
function isStalledPass(
  push: PushPendingMutationsResult,
  pullAfterPush: PullOnceResult | void,
): boolean {
  if (!push.shouldPullAfterPush || !pullAfterPush) {
    return false;
  }

  return (
    push.mutationsPushed === 0 &&
    push.conflictsCreated === 0 &&
    push.mutationsRequeued > 0 &&
    pullAfterPush.entriesApplied === 0 &&
    pullAfterPush.conflictsCreated === 0
  );
}

function isRealtimeConnectionError(error: unknown): boolean {
  return error instanceof SyncRealtimeConnectionError;
}

function isCursorAheadOfServerError(error: unknown): boolean {
  return (
    error instanceof SyncRealtimeError && error.code === "cursor_ahead_of_server"
  );
}
