import { isOfflineLikeError, isTransientSyncError } from "../../http/network-status";
import { SyncBlobClient } from "../remote/blob-client";
import type { ConflictFileWriter } from "../core/conflict-file";
import {
  createSyncCryptoContext,
  type SyncCryptoContext,
} from "../core/crypto";
import type { SyncTokenResponse } from "../remote/client";
import {
  type CommitMutationBatchResult,
  SYNC_FEATURE_GET_ENTRY_STATES,
  SyncRealtimeError,
  type SyncRealtimeSession,
} from "../remote/realtime-client";
import type {
  AcceptedPushMutationRow,
  PendingMutationRow,
  SyncProgressCounts,
} from "../store/store";
import type {
  SyncCursorStore,
  SyncEntryStore,
  SyncMutationStore,
  SyncStoreLifecycle,
} from "../store/ports";
import {
  type LocalFileReader,
  PushMutationCommitter,
  type PushConflictEvent,
  type PushMutationStore,
  type PreparedPushMutation,
} from "./push-mutation-committer";
import type { PullConflictEvent } from "./pull-entry-state-applier";
import type { ApplyEntryStatesByIdResult } from "./pull-service";
import {
  type StaleRecoveryEvent,
  type StaleRecoveryOutcome,
  StaleMutationUnresolvedError,
  type UnresolvedStaleRecoveryEvent,
} from "./push-stale-recovery";

const DEFAULT_PUSH_BATCH = 100;
const DEFAULT_PUSH_DRAIN_LIMIT = 1_000;
const DEFAULT_PUSH_PREPARE_CONCURRENCY = 12;
/**
 * Consecutive commit rejections before a mutation is treated as stuck.
 *
 * High enough that a service blip, a failover or a brief outage is ridden out
 * by the normal retry, low enough that a genuinely broken mutation stops
 * blocking the queue within a minute or so rather than forever.
 */
const MAX_COMMIT_ATTEMPTS = 5;
/**
 * Stale rejections one entry may collect, from the same base revision, before
 * it is set aside no matter what.
 *
 * Every stale rejection costs a blob upload, because the upload happens before
 * the commit is attempted. The pair check below normally ends a loop after two
 * rejections; this is the backstop for a server whose revision keeps moving
 * while this device's base cannot, which would otherwise never repeat a pair.
 */
const MAX_STALE_REJECTIONS = 4;
/**
 * Codes with which the server refuses a lookup by id outright, as opposed to
 * failing while answering it. Only these set a stale change aside at once;
 * anything else is retried like any other server error, within the rejection
 * cap above.
 */
const STALE_RECOVERY_REFUSALS = new Set(["invalid_message", "feature_unavailable"]);

/**
 * A mutation whose preparation failed in a way worth retrying. It stays in
 * the queue, and the error is surfaced once the rest of the batch is done.
 */
interface RetryLaterPreparation {
  retryLater: true;
  error: unknown;
}

export interface SyncPushServiceDeps {
  getApiBaseUrl: () => string;
  getSyncToken: () => Promise<SyncTokenResponse>;
  getSyncStore: () => SyncPushStore | null;
  getRemoteVaultKey: () => Uint8Array;
  fileReader: LocalFileReader;
  conflictFileWriter?: ConflictFileWriter;
  blobClient?: SyncBlobClient;
  prepareConcurrency?: number;
  onProgress: (progress: SyncProgressCounts) => Promise<void>;
  onConflict?: (event: PushConflictEvent) => void;
  onFileSizeBlockedFilesChange?: () => void;
  /**
   * Called when a mutation is parked because preparing it failed in a way that
   * would fail again. Lets the surrounding runtime tell the user which file
   * needs attention instead of leaving a silently smaller sync.
   */
  onMutationQuarantined?: (event: {
    entryId: string;
    mutationId: string;
    error: unknown;
  }) => void;
  /**
   * Fetch specific entries and apply them through the pull machinery, without
   * moving the pull cursor. Used to reconcile a change the server keeps
   * rejecting as stale when an ordinary pull cannot. Absent, a repeated stale
   * rejection is set aside without trying.
   */
  applyEntryStatesById?: (
    session: SyncRealtimeSession,
    entryIds: string[],
  ) => Promise<ApplyEntryStatesByIdResult>;
  /**
   * Called when that reconciliation succeeds. A failure is reported through
   * `onMutationQuarantined` instead, because the file is then set aside.
   */
  onStaleRecovery?: (event: StaleRecoveryEvent) => void;
  now?: () => number;
}

export interface SyncPushStore
  extends SyncCursorStore,
    Pick<SyncEntryStore, "countSyncProgress">,
    Pick<
      SyncMutationStore,
      "listBlockedDirtyEntriesByReason" | "listDirtyEntries" | "updateDirtyEntry"
    >,
    Pick<SyncStoreLifecycle, "flush">,
    PushMutationStore {}

export interface PushPendingMutationsResult {
  cursor: number;
  mutationsPushed: number;
  mutationsRequeued: number;
  filesCreatedOrUpdated: number;
  filesDeleted: number;
  conflictsCreated: number;
  shouldPullAfterPush: boolean;
  hasMore: boolean;
  stopReason?: "storage_quota_exceeded";
  /**
   * Set when a file's upload failed in a way worth retrying, and is still
   * queued. The rest of the batch went through; the caller should back off
   * before pushing again, and report the error.
   */
  retryLater?: { error: unknown };
}

export class SyncPushService {
  /**
   * Consecutive commit failures per mutation. In memory on purpose: a restart
   * genuinely is a fresh chance, and persisting it would keep punishing a file
   * for an outage that has since ended.
   */
  private readonly commitFailures = new Map<string, number>();
  /**
   * Consecutive retryable prepare failures per mutation, the prepare-side
   * twin of `commitFailures`.
   *
   * Server errors and Chromium's network errors are retried rather than blamed
   * on the file, which is right for a blip. But a file whose upload fails the
   * same way every time - the API answers anything unexpected with a 500 -
   * would be retried forever, so after as many attempts as a commit gets it is
   * parked like any other file that cannot be prepared.
   */
  private readonly prepareFailures = new Map<string, number>();
  /**
   * The last stale rejection per entry, and whether recovery has been tried
   * for it. In memory for the same reason as `commitFailures`.
   *
   * A stale rejection used to count as progress: the server said "pull
   * first", so the push stepped aside, the pull ran, and the push tried again.
   * That is right when the pull brings the newer revision down and rebases the
   * change. When it cannot - the newer revision will not decrypt, its path is
   * excluded here, or the pull cursor is already past it - nothing changes,
   * and the same blob was uploaded about once a second: 837 times in 12.8
   * minutes for one 13 KB note, every upload accepted, no commit landing. The
   * rejection itself says whether a pull helped, because it names both
   * revisions, so the same pair twice means it did not.
   *
   * Keyed by entry, not by queued change. Obsidian autosaves a note being
   * edited every couple of seconds, so on a note someone is working in each
   * rejection can come from a different change - all built on the same base,
   * all rejected with the same pair.
   */
  private readonly staleRejections = new Map<
    string,
    {
      serverRevision: number;
      baseRevision: number;
      rejections: number;
      recoveryAttempted: boolean;
    }
  >();
  /**
   * The base revision each entry's stale change was set aside from.
   *
   * Parking stops one change, but on a note being edited Obsidian queues a
   * new one every autosave, on the same base, and the server rejects each
   * with the same pair. Without this, every one of them started over - two
   * uploads, a fetch by id and a new notice per autosave - which is the loop
   * the parking was there to stop. A change from the same base cannot land
   * either, since the server is already past it, so it is set aside before
   * anything is uploaded. A change from any other base means a pull moved
   * it, and goes through as normal.
   */
  private readonly parkedStaleBases = new Map<string, number>();

  constructor(private readonly deps: SyncPushServiceDeps) {}

  async pushPendingMutations(
    session: SyncRealtimeSession,
  ): Promise<PushPendingMutationsResult> {
    const store = this.deps.getSyncStore();
    if (!store) {
      throw new Error("Sync store is not initialized.");
    }

    const token = await this.deps.getSyncToken();
    const startingCursor = await store.getCursor();
    let cursor = startingCursor;
    let checkpointCursor = startingCursor;
    let mutationsPushed = 0;
    let mutationsRequeued = 0;
    let filesCreatedOrUpdated = 0;
    let filesDeleted = 0;
    let conflictsCreated = 0;
    let fileSizeBlocked = 0;
    let shouldPullAfterPush = false;
    const acceptedCursors: number[] = [];
    let processedMutations = 0;
    let hasMore = false;
    let stopAfterCurrentBatch = false;
    let stopReason: PushPendingMutationsResult["stopReason"];
    let retryLater: { error: unknown } | undefined;

    const remoteVaultKey = this.deps.getRemoteVaultKey();
    const syncCryptoContext = createSyncCryptoContext(remoteVaultKey);
    const mutationCommitter = this.createMutationCommitter(
      remoteVaultKey,
      syncCryptoContext,
    );
    try {
      while (processedMutations < DEFAULT_PUSH_DRAIN_LIMIT) {
        const remainingBudget = DEFAULT_PUSH_DRAIN_LIMIT - processedMutations;
        const pending = await store.listDirtyEntries(
          Math.min(DEFAULT_PUSH_BATCH, remainingBudget),
        );
        if (pending.length === 0) {
          hasMore = false;
          break;
        }

        const preparedMutations = await this.preparePendingMutations(
          mutationCommitter,
          store,
          token,
          session,
          pending,
        );

        const committable: Array<{
          mutation: (typeof preparedMutations)[number]["mutation"];
          prepared: PreparedPushMutation;
        }> = [];

        for (const { mutation, prepared } of preparedMutations) {
          processedMutations += 1;

          if (!prepared) {
            mutationsRequeued += 1;
            continue;
          }
          if ("retryLater" in prepared) {
            // Only this mutation waits. The rest of the batch commits, and
            // the batch ends here so the same file is not prepared again
            // straight away from the next listing. The caller backs off
            // before the next push, as it would for a thrown error, but
            // still runs any pull this push asked for.
            mutationsRequeued += 1;
            stopAfterCurrentBatch = true;
            retryLater ??= { error: prepared.error };
            continue;
          }
          if ("skipped" in prepared) {
            if (prepared.reason === "file_too_large") {
              fileSizeBlocked += 1;
            }
            if (prepared.reason === "storage_quota_exceeded") {
              stopAfterCurrentBatch = true;
              stopReason = "storage_quota_exceeded";
              break;
            }
            continue;
          }

          committable.push({ mutation, prepared });
        }

        if (committable.length === 0) {
          await this.reportProgress(store);
          if (stopAfterCurrentBatch) {
            break;
          }
          continue;
        }

        const committed = await session.commitMutations(
          committable.map(({ prepared }) => prepared.commitPayload),
        );
        const resultsByMutationId = new Map(
          committed.results.map((result) => [result.mutationId, result]),
        );

        const acceptedPushMutations: AcceptedPushMutationRow[] = [];
        const rejectedPushMutations: Array<{
          mutation: (typeof committable)[number]["mutation"];
          result: Extract<CommitMutationBatchResult, { status: "rejected" }>;
        }> = [];
        for (const { mutation, prepared } of committable) {
          const batchResult = resultsByMutationId.get(mutation.mutationId);
          if (!batchResult) {
            throw new Error(`Commit batch did not include ${mutation.mutationId}.`);
          }

          if (batchResult.status === "accepted") {
            acceptedPushMutations.push(
              await mutationCommitter.buildAcceptedPushMutation(
                mutation,
                prepared,
                batchResult,
              ),
            );
            cursor = Math.max(cursor, batchResult.cursor);
            acceptedCursors.push(batchResult.cursor);
            this.staleRejections.delete(mutation.entryId);
            this.parkedStaleBases.delete(mutation.entryId);
            filesCreatedOrUpdated += mutation.op === "upsert" ? 1 : 0;
            filesDeleted += mutation.op === "delete" ? 1 : 0;
            mutationsPushed += 1;
            continue;
          }

          rejectedPushMutations.push({ mutation, result: batchResult });
        }

        await store.applyAcceptedPushBatch(acceptedPushMutations, {
          remoteVaultKey,
        });

        for (const { mutation, result: batchResult } of rejectedPushMutations) {
          // A rejection the committer cannot resolve throws, which aborts the
          // drain so the whole batch retries. That is right for a transient
          // rejection - "service unavailable" should be tried again, not
          // treated as the file's fault.
          //
          // What was missing is an end to it. A mutation the server rejects
          // identically every time re-uploaded its blob and was rejected again
          // on every retry, forever, while everything queued behind it waited.
          // Observed as the same blob uploaded seven times in a row, every
          // upload accepted, no commit ever landing.
          //
          // So: keep retrying, but not indefinitely. After enough consecutive
          // failures the mutation is treated as stuck rather than unlucky, and
          // parked so the rest of the vault can move.
          let result;
          try {
            result = await mutationCommitter.handleRejectedPreparedMutation(
              store,
              mutation,
              batchResult,
            );
            this.commitFailures.delete(mutation.mutationId);
          } catch (error) {
            const attempts = (this.commitFailures.get(mutation.mutationId) ?? 0) + 1;
            if (attempts < MAX_COMMIT_ATTEMPTS) {
              this.commitFailures.set(mutation.mutationId, attempts);
              throw error;
            }

            this.commitFailures.delete(mutation.mutationId);
            await store.updateDirtyEntry({
              ...mutation,
              status: "blocked",
              blockedReason: "prepare_failed",
            });
            this.deps.onMutationQuarantined?.({
              entryId: mutation.entryId,
              mutationId: mutation.mutationId,
              error,
            });
            continue;
          }
          conflictsCreated += result.conflictsCreated;

          if (result.status === "stale") {
            const resolution = await this.resolveStaleRejection(
              session,
              store,
              mutation,
              batchResult,
            );
            if (resolution.kind === "retry") {
              shouldPullAfterPush = true;
              mutationsRequeued += 1;
              stopAfterCurrentBatch = true;
            }
            conflictsCreated += resolution.conflictsCreated;
            continue;
          }
          shouldPullAfterPush = shouldPullAfterPush || result.shouldPullAfterPush;
          if (result.status === "requeued") {
            mutationsRequeued += 1;
            continue;
          }
          if (result.status === "conflict") {
            this.staleRejections.delete(mutation.entryId);
            this.parkedStaleBases.delete(mutation.entryId);
            continue;
          }
        }
        await this.reportProgress(store);
        if (stopAfterCurrentBatch) {
          break;
        }
      }

      hasMore = (await store.listDirtyEntries(1)).length > 0;
      checkpointCursor = getContiguousAcceptedCursor(
        checkpointCursor,
        acceptedCursors,
      );
      if (checkpointCursor > startingCursor) {
        await store.setCursor(checkpointCursor);
      }
      shouldPullAfterPush =
        shouldPullAfterPush ||
        acceptedCursors.some((acceptedCursor) => acceptedCursor > checkpointCursor);
    } finally {
      syncCryptoContext.dispose();
      await store.flush();
    }

    // TODO: Refresh file-size-blocked decorations when existing blocked files become syncable.
    if (fileSizeBlocked > 0) {
      this.deps.onFileSizeBlockedFilesChange?.();
    }

    return {
      cursor,
      mutationsPushed,
      mutationsRequeued,
      filesCreatedOrUpdated,
      filesDeleted,
      conflictsCreated,
      shouldPullAfterPush,
      hasMore,
      ...(stopReason ? { stopReason } : {}),
      ...(retryLater ? { retryLater } : {}),
    };
  }

  /**
   * Give parked changes a fresh attempt when a new sync session starts.
   *
   * A parked mutation is excluded from the pending queue, so without this it
   * waits until the user happens to edit that file again - which they will not
   * do, because they do not know it is parked. That turns "set aside so the
   * rest can sync" into "silently stops syncing", which is the one outcome a
   * sync tool must not have.
   *
   * Reconnecting is a meaningful change in circumstances: a new session, often
   * a new network, sometimes a restarted server. If the change fails again it
   * is parked again - after one attempt when its upload already used up its
   * retries, after five more commit failures otherwise - so this cannot spin:
   * it is a fresh chance, not a retry loop.
   *
   * `stale_unresolved` is deliberately not included. Nothing about a new
   * session changes why it was parked: the server's newer revision is still
   * undecryptable, still excluded, or still behind a cursor this device has
   * passed. Un-parking it on every reconnect is exactly how the loop it was
   * parked to stop came back - in episodes, one per dropped connection. It
   * comes back on an explicit retry. Editing the file queues a new change in
   * its place, which is set aside too while it is built on the same base.
   */
  async retryQuarantinedMutations(): Promise<number> {
    return await this.unparkMutations(["prepare_failed"], { freshPrepareCount: false });
  }

  /**
   * Put every parked change back in the queue, because the user asked.
   *
   * Unlike a reconnect, a person pressing "Try these again" may have just
   * fixed the cause - re-saved the note on another device, changed a sync
   * rule, updated the server - so the stale ones get their chance too.
   */
  async retryParkedMutations(): Promise<number> {
    return await this.unparkMutations(["prepare_failed", "stale_unresolved"], {
      freshPrepareCount: true,
    });
  }

  /**
   * `freshPrepareCount` is false for a reconnect. A file that used up its
   * retryable prepare failures then gets one attempt, not a new five: with a
   * fresh count, a server that kept failing its upload cost five uploads and a
   * notice per reconnect.
   */
  private async unparkMutations(
    reasons: Array<"prepare_failed" | "stale_unresolved">,
    options: { freshPrepareCount: boolean },
  ): Promise<number> {
    const store = this.deps.getSyncStore();
    if (!store) {
      return 0;
    }

    let unparked = 0;
    for (const reason of reasons) {
      const parked = await store.listBlockedDirtyEntriesByReason(reason);
      for (const mutation of parked) {
        this.commitFailures.delete(mutation.mutationId);
        if (options.freshPrepareCount) {
          this.prepareFailures.delete(mutation.mutationId);
        }
        this.staleRejections.delete(mutation.entryId);
        this.parkedStaleBases.delete(mutation.entryId);
        await store.updateDirtyEntry({
          ...mutation,
          status: "pending",
          blockedReason: null,
        });
      }
      unparked += parked.length;
    }
    return unparked;
  }

  async unblockFileSizeBlockedMutations(maxFileSizeBytes: number): Promise<number> {
    const store = this.deps.getSyncStore();
    if (!store) {
      throw new Error("Sync store is not initialized.");
    }

    const blocked = await store.listBlockedDirtyEntriesByReason("file_too_large");
    let unblocked = 0;
    for (const mutation of blocked) {
      if (!shouldUnblockFileSizeMutation(mutation, maxFileSizeBytes)) {
        continue;
      }

      await store.updateDirtyEntry({
        ...mutation,
        status: "pending",
        blockedReason: null,
        blockedEncryptedSizeBytes: null,
        blockedMaxFileSizeBytes: null,
      });
      unblocked += 1;
    }

    if (unblocked > 0) {
      await store.flush();
    }

    return unblocked;
  }

  /**
   * Decide what a stale rejection means for this change.
   *
   * The first rejection with a given pair of revisions is the ordinary case -
   * another device changed the file - and a pull fixes it, so the change is
   * requeued behind one. The same pair for the same entry again means that
   * pull did not move the base, whichever queued change carried it. Then the
   * entry is fetched by id and applied the way a pull would have, and
   * whatever still does not fit is set aside with the reason, keeping the
   * edit on this device.
   */
  private async resolveStaleRejection(
    session: SyncRealtimeSession,
    store: SyncPushStore,
    mutation: PendingMutationRow,
    rejection: Extract<CommitMutationBatchResult, { status: "rejected" }>,
  ): Promise<{ kind: "retry" | "resolved" | "parked"; conflictsCreated: number }> {
    const serverRevision = rejection.expectedBaseRevision ?? mutation.baseRevision + 1;
    const baseRevision = rejection.receivedBaseRevision ?? mutation.baseRevision;
    const previous = this.staleRejections.get(mutation.entryId);
    const samePair =
      !!previous &&
      previous.serverRevision === serverRevision &&
      previous.baseRevision === baseRevision;
    const record = {
      serverRevision,
      baseRevision,
      // Counted per base, not per pair: a base that moved is progress, while
      // a server revision that keeps moving past a base that cannot is not.
      rejections:
        previous && previous.baseRevision === baseRevision ? previous.rejections + 1 : 1,
      // Carried across a replaced change too. If recovery rebased or merged
      // it and the server still answers with the very same pair, recovery
      // does not help here, and running it again would only upload again.
      recoveryAttempted: samePair && previous.recoveryAttempted,
    };
    this.staleRejections.set(mutation.entryId, record);

    const event = {
      entryId: mutation.entryId,
      mutationId: mutation.mutationId,
      op: mutation.op,
      serverRevision,
      baseRevision,
    };
    if (record.rejections >= MAX_STALE_REJECTIONS || record.recoveryAttempted) {
      return await this.parkStaleMutation(store, mutation, {
        ...event,
        outcome: { resolved: false, reason: "repeated" },
      });
    }
    if (!samePair) {
      return { kind: "retry", conflictsCreated: 0 };
    }

    const { outcome, conflictsCreated } = await this.recoverStaleMutation(
      session,
      store,
      mutation,
    );
    record.recoveryAttempted = true;
    if (!outcome.resolved) {
      return await this.parkStaleMutation(store, mutation, { ...event, outcome });
    }

    // The record is kept rather than cleared. A merge queues a new change,
    // and if that one is rejected from the same base the count carries on,
    // so a server that contradicts itself still reaches the cap.
    this.deps.onStaleRecovery?.({ ...event, outcome });
    return { kind: "resolved", conflictsCreated };
  }

  private async recoverStaleMutation(
    session: SyncRealtimeSession,
    store: SyncPushStore,
    mutation: PendingMutationRow,
  ): Promise<{ outcome: StaleRecoveryOutcome; conflictsCreated: number }> {
    if (
      !this.deps.applyEntryStatesById ||
      !session.features.includes(SYNC_FEATURE_GET_ENTRY_STATES)
    ) {
      return {
        outcome: { resolved: false, reason: "fetch_unavailable" },
        conflictsCreated: 0,
      };
    }

    let applied: ApplyEntryStatesByIdResult;
    try {
      applied = await this.deps.applyEntryStatesById(session, [mutation.entryId]);
    } catch (error) {
      // The server refused the request itself, which it will do again. Every
      // other failure - the server erring while it answered, a dropped
      // socket, a failed blob download - is rethrown for the ordinary retry,
      // and the rejection cap still bounds how often that can happen. Parking
      // over those would be wrong for longer than it looks: a reconnect
      // never un-parks a stale change, so one hiccup here would leave the
      // note stuck until someone noticed.
      if (error instanceof SyncRealtimeError && STALE_RECOVERY_REFUSALS.has(error.code)) {
        return {
          outcome: { resolved: false, reason: "fetch_failed", detail: error.message },
          conflictsCreated: 0,
        };
      }
      throw error;
    }

    // The pull machinery decides what happens to a pending change, so the
    // only reliable way to know what it did is to look at the change after.
    const current = await store.getDirtyEntryMutation(mutation.entryId);
    const fetched = applied.entries.get(mutation.entryId) ?? { status: "missing" as const };
    if (!current) {
      return {
        outcome: {
          resolved: true,
          how: describeClearedPendingChange(
            mutation,
            applied.pendingConflicts.find((event) => event.entryId === mutation.entryId),
            fetched.status === "applied" && fetched.deleted,
          ),
        },
        conflictsCreated: applied.conflictsCreated,
      };
    }
    if (current.mutationId !== mutation.mutationId) {
      return {
        outcome: { resolved: true, how: "merged" },
        conflictsCreated: applied.conflictsCreated,
      };
    }

    switch (fetched.status) {
      case "missing":
        return { outcome: { resolved: false, reason: "not_on_server" }, conflictsCreated: 0 };
      case "undecryptable":
        return {
          outcome: { resolved: false, reason: "undecryptable", remoteRevision: fetched.revision },
          conflictsCreated: 0,
        };
      case "excluded":
        return {
          outcome: {
            resolved: false,
            reason: "excluded",
            remoteRevision: fetched.revision,
            remotePath: fetched.path,
          },
          conflictsCreated: 0,
        };
      case "applied":
        return {
          outcome: { resolved: false, reason: "not_applied", remoteRevision: fetched.revision },
          conflictsCreated: 0,
        };
    }
  }

  /**
   * Stop uploading a change that cannot land, without losing it.
   *
   * The change stays in the queue, blocked, with its file untouched, so the
   * edit is still on this device and is what gets uploaded once the cause is
   * fixed. It is listed under Files not syncing with the reason.
   */
  private async parkStaleMutation(
    store: SyncPushStore,
    mutation: PendingMutationRow,
    event: UnresolvedStaleRecoveryEvent,
  ): Promise<{ kind: "retry" | "parked"; conflictsCreated: number }> {
    this.staleRejections.delete(mutation.entryId);
    this.commitFailures.delete(mutation.mutationId);

    // Recovery runs the pull machinery, which can replace the queued change.
    // Parking a row that is no longer the one queued would block an edit that
    // has not even been tried yet.
    const current = await store.getDirtyEntryMutation(mutation.entryId);
    if (!current || current.mutationId !== mutation.mutationId) {
      return { kind: "retry", conflictsCreated: 0 };
    }

    await store.updateDirtyEntry({
      ...current,
      status: "blocked",
      blockedReason: "stale_unresolved",
    });
    this.parkedStaleBases.set(mutation.entryId, current.baseRevision);
    this.deps.onMutationQuarantined?.({
      entryId: mutation.entryId,
      mutationId: mutation.mutationId,
      error: new StaleMutationUnresolvedError(event),
    });
    return { kind: "parked", conflictsCreated: 0 };
  }

  private async reportProgress(store: SyncPushStore): Promise<void> {
    const progress = await store.countSyncProgress();
    if (progress.totalEntries <= 0) {
      return;
    }

    await this.deps.onProgress(progress);
  }

  private createMutationCommitter(
    remoteVaultKey: Uint8Array,
    syncCryptoContext: SyncCryptoContext,
  ): PushMutationCommitter {
    return new PushMutationCommitter({
      getApiBaseUrl: () => this.deps.getApiBaseUrl(),
      getRemoteVaultKey: () => remoteVaultKey,
      getSyncCryptoContext: () => syncCryptoContext,
      fileReader: this.deps.fileReader,
      conflictFileWriter: this.deps.conflictFileWriter,
      blobClient: this.deps.blobClient,
      onConflict: this.deps.onConflict,
      now: this.deps.now,
    });
  }

  private async preparePendingMutations(
    mutationCommitter: PushMutationCommitter,
    store: SyncPushStore,
    token: SyncTokenResponse,
    session: SyncRealtimeSession,
    pending: PendingMutationRow[],
  ): Promise<
    Array<{
      mutation: (typeof pending)[number];
      prepared:
        | Awaited<ReturnType<PushMutationCommitter["prepareMutationForCommit"]>>
        | RetryLaterPreparation;
    }>
  > {
    return await mapWithConcurrency(
      pending,
      this.deps.prepareConcurrency ?? DEFAULT_PUSH_PREPARE_CONCURRENCY,
      async (mutation) => ({
        mutation,
        prepared: await this.prepareOneOrQuarantine(
          mutationCommitter,
          store,
          token,
          session,
          mutation,
        ),
      }),
    );
  }

  /**
   * Prepare one mutation, and never let it take the batch down with it.
   *
   * A push prepares every mutation in a batch before committing any of them, so
   * a single throw used to abort the whole drain and stop sync outright. The
   * causes are mundane and unavoidable in a real vault - a note renamed while
   * the push was in flight, an attachment replaced mid-read, a file the OS will
   * not hand over - but the blast radius was total, and the notice named none
   * of them.
   *
   * Transient failures are retried, not parked: a dropped connection must not
   * quarantine a perfectly good file. When the link itself is down the whole
   * batch is abandoned, because every other file would fail the same way. A
   * server error is retried for this file alone, so a file the server keeps
   * failing cannot hold the others back, and only up to a limit. Anything
   * that would fail identically next attempt is parked with a reason, so the
   * rest of the batch still goes through and the user can be told which file
   * needs attention rather than watching sync stop.
   */
  private async prepareOneOrQuarantine(
    mutationCommitter: PushMutationCommitter,
    store: SyncPushStore,
    token: SyncTokenResponse,
    session: SyncRealtimeSession,
    mutation: PendingMutationRow,
  ): Promise<
    | Awaited<ReturnType<PushMutationCommitter["prepareMutationForCommit"]>>
    | RetryLaterPreparation
  > {
    if (this.parkedStaleBases.get(mutation.entryId) === mutation.baseRevision) {
      // Already reported when the first change from this base was set aside,
      // and still listed under Files not syncing, so no second notice.
      await store.updateDirtyEntry({
        ...mutation,
        status: "blocked",
        blockedReason: "stale_unresolved",
      });
      return { skipped: true, reason: "stale_unresolved" };
    }

    try {
      const prepared = await mutationCommitter.prepareMutationForCommit(
        store,
        token,
        mutation,
        session.maxFileSizeBytes,
      );
      this.prepareFailures.delete(mutation.mutationId);
      return prepared;
    } catch (error) {
      // navigator.onLine is deliberately ignored here: during a real outage it
      // reports offline for everything, and quarantining a file because the
      // wifi dropped would be exactly the wrong call. Only the error decides
      // whether this is worth retrying.
      //
      // "Offline" alone was too narrow. A connection reset worded the way
      // Chromium words it, an expired token, an overloaded server - none is the
      // file's fault, and each parked a good file that the next reconnect then
      // un-parked, which is how the upload loop came back in episodes.
      if (isOfflineLikeError(error, () => false)) {
        throw error;
      }
      if (isTransientSyncError(error, () => false)) {
        // Rethrowing this used to abort the whole batch. With one file the
        // server failed every time, that meant no file behind it ever
        // committed, and every one of them was uploaded again on each retry.
        const attempts = (this.prepareFailures.get(mutation.mutationId) ?? 0) + 1;
        if (attempts < MAX_COMMIT_ATTEMPTS) {
          this.prepareFailures.set(mutation.mutationId, attempts);
          return { retryLater: true, error };
        }
        // Parked with one attempt left, which is what the next reconnect
        // spends. See `unparkMutations`.
        this.prepareFailures.set(mutation.mutationId, MAX_COMMIT_ATTEMPTS - 1);
      } else {
        this.prepareFailures.delete(mutation.mutationId);
      }

      await store.updateDirtyEntry({
        ...mutation,
        status: "blocked",
        blockedReason: "prepare_failed",
      });
      this.deps.onMutationQuarantined?.({
        entryId: mutation.entryId,
        mutationId: mutation.mutationId,
        error,
      });
      return { skipped: true, reason: "prepare_failed" };
    }
  }
}

/**
 * How the pull settled a pending change it cleared. No conflict event means
 * the server already had the change; an event says what was kept instead.
 *
 * A delete cleared against a server state that is itself deleted was not
 * undone, whatever the event says. The event compares paths, so a note
 * another device moved and then deleted reports a conflict, but nothing was
 * restored.
 */
function describeClearedPendingChange(
  mutation: PendingMutationRow,
  conflict: PullConflictEvent | undefined,
  serverDeleted: boolean,
): Extract<StaleRecoveryOutcome, { resolved: true }>["how"] {
  if (!conflict || (mutation.op === "delete" && serverDeleted)) {
    return "already_on_server";
  }
  if (conflict.conflictPath) {
    return "conflict_copy";
  }
  return mutation.op === "delete" ? "delete_undone" : "server_version_kept";
}

function getContiguousAcceptedCursor(
  currentCursor: number,
  acceptedCursors: number[],
): number {
  if (acceptedCursors.length === 0) {
    return currentCursor;
  }

  const remaining = new Set(acceptedCursors);
  let cursor = currentCursor;
  while (remaining.delete(cursor + 1)) {
    cursor += 1;
  }
  return cursor;
}

function shouldUnblockFileSizeMutation(
  mutation: PendingMutationRow,
  maxFileSizeBytes: number,
): boolean {
  if (maxFileSizeBytes === 0) {
    return true;
  }

  const encryptedSizeBytes = mutation.blockedEncryptedSizeBytes;
  return (
    typeof encryptedSizeBytes === "number" &&
    encryptedSizeBytes <= maxFileSizeBytes
  );
}

async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<U>,
): Promise<U[]> {
  if (items.length === 0) {
    return [];
  }

  const results = new Array<U>(items.length);
  let nextIndex = 0;
  let firstError: unknown = null;
  const workerCount = normalizeConcurrency(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length && !firstError) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          results[index] = await mapper(items[index]);
        } catch (error) {
          firstError = firstError ?? error;
        }
      }
    }),
  );

  if (firstError) {
    throw firstError;
  }

  return results;
}

function normalizeConcurrency(concurrency: number, itemCount: number): number {
  const normalizedConcurrency = Number.isFinite(concurrency) ? Math.floor(concurrency) : 1;
  return Math.max(1, Math.min(normalizedConcurrency, itemCount));
}
