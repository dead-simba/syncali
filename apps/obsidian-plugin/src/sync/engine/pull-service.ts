import type { SyncTokenResponse } from "../remote/client";
import type { SyncEventGateLike } from "./event-gate";
import { SyncPullClient } from "../remote/pull-client";
import type { SyncRealtimeSession } from "../remote/realtime-client";
import type {
  SyncCursorStore,
  SyncStoreLifecycle,
} from "../store/ports";
import type { SyncProgressCounts } from "../store/store";
import {
  type PullConflictEvent,
  PullEntryStateApplier,
  type PullEntryStateManifestApplyResult,
  type PullEntryStateStore,
  type PullEntryStateManifestItem,
  type PullEntryStateVaultAdapter,
  type PullRollbackEvent,
} from "./pull-entry-state-applier";

const DEFAULT_PULL_BATCH = 50;
const DEFAULT_PULL_APPLY_WINDOW = 200;
const DEFAULT_PULL_PREPARE_CONCURRENCY = 10;

export interface SyncPullServiceDeps {
  getApiBaseUrl: () => string;
  getSyncToken: () => Promise<SyncTokenResponse>;
  getSyncStore: () => SyncPullStore | null;
  getRemoteVaultKey: () => Uint8Array;
  shouldApplyRemotePath?: (path: string) => boolean;
  onUndecryptableEntry?: (event: {
    entryId: string;
    revision: number;
    updatedAt: number;
    deleted: boolean;
    error: unknown;
  }) => void;
  vaultAdapter: PullVaultAdapter;
  eventGate?: SyncEventGateLike;
  pullClient?: Pick<SyncPullClient, "downloadBlob">;
  prepareConcurrency?: number;
  applyWindowSize?: number;
  onProgress: (progress: SyncProgressCounts) => Promise<void>;
  onConflict?: (event: PullConflictEvent) => void;
  onRollbackDetected?: (event: PullRollbackEvent) => void;
  now?: () => number;
}

export interface SyncPullStore
  extends SyncCursorStore,
    Pick<SyncStoreLifecycle, "flush">,
    PullEntryStateStore {}

export interface PullOnceResult {
  cursor: number;
  entriesApplied: number;
  filesWritten: number;
  filesDeleted: number;
  conflictsCreated: number;
}

/**
 * What happened to one entry fetched by id.
 *
 * The caller asked for these entries because a pending change could not be
 * reconciled any other way, so "nothing happened" is not enough of an answer:
 * which of these it was decides what the user is told.
 */
export type EntryStateByIdOutcome =
  /** The server does not have the entry. */
  | { status: "missing" }
  /** The entry's metadata would not decrypt, so it could not be planned. */
  | { status: "undecryptable"; revision: number }
  /** The entry's path is one this device does not sync. Nothing was applied. */
  | { status: "excluded"; revision: number; path: string }
  /**
   * The entry went through the normal apply path. `deleted` is the server's
   * state, which is what says how a pending change it cleared was settled.
   */
  | { status: "applied"; revision: number; path: string; deleted: boolean };

export interface ApplyEntryStatesByIdResult extends PullEntryStateManifestApplyResult {
  entries: Map<string, EntryStateByIdOutcome>;
}

export class SyncPullService {
  private readonly pullClient: Pick<SyncPullClient, "downloadBlob">;
  private readonly entryStateApplier: PullEntryStateApplier;

  constructor(private readonly deps: SyncPullServiceDeps) {
    this.pullClient = deps.pullClient ?? new SyncPullClient();
    this.entryStateApplier = new PullEntryStateApplier({
      getApiBaseUrl: () => this.deps.getApiBaseUrl(),
      getRemoteVaultKey: () => this.deps.getRemoteVaultKey(),
      vaultAdapter: this.deps.vaultAdapter,
      eventGate: this.deps.eventGate,
      pullClient: this.pullClient,
      shouldApplyRemotePath: this.deps.shouldApplyRemotePath,
      onUndecryptableEntry: this.deps.onUndecryptableEntry,
      prepareConcurrency:
        this.deps.prepareConcurrency ?? DEFAULT_PULL_PREPARE_CONCURRENCY,
      onProgress: async (progress) => {
        await this.deps.onProgress(progress);
      },
      onConflict: this.deps.onConflict,
      onRollbackDetected: this.deps.onRollbackDetected,
      now: this.deps.now,
    });
  }

  async pullOnce(session: SyncRealtimeSession): Promise<PullOnceResult> {
    const store = this.deps.getSyncStore();
    if (!store) {
      throw new Error("Sync store is not initialized.");
    }

    const token = await this.deps.getSyncToken();
    const requestCursor = await store.getCursor();
    let cursor = requestCursor;
    let hasMore = true;
    let targetCursor: number | null = null;
    let totalEntries = 0;
    let after: { updatedSeq: number; entryId: string } | null = null;
    let window: PullEntryStateManifestItem[] = [];
    const applyWindowSize = normalizePositiveInteger(
      this.deps.applyWindowSize,
      DEFAULT_PULL_APPLY_WINDOW,
    );
    const totals = {
      entriesApplied: 0,
      filesWritten: 0,
      filesDeleted: 0,
      conflictsCreated: 0,
    };

    while (hasMore) {
      const page = await session.listEntryStates({
        sinceCursor: requestCursor,
        targetCursor,
        after,
        limit: DEFAULT_PULL_BATCH,
      });
      targetCursor = page.targetCursor;
      totalEntries = page.totalEntries;
      window.push(...(await this.entryStateApplier.createManifestItems(page.entries)));
      after = page.nextAfter;
      hasMore = page.hasMore;

      if (window.length >= applyWindowSize || !hasMore) {
        const appliedWindow = window;
        const applied = await this.entryStateApplier.applyManifestWindow(
          store,
          token,
          window,
          {
            finalWindow: !hasMore,
            progress: {
              completedOffset: totals.entriesApplied,
              totalEntries,
            },
          },
        );
        totals.entriesApplied += applied.entriesApplied;
        totals.filesWritten += applied.filesWritten;
        totals.filesDeleted += applied.filesDeleted;
        totals.conflictsCreated += applied.conflictsCreated;
        window = applied.deferred;
        cursor = await this.checkpointAppliedWindow(
          store,
          session,
          cursor,
          appliedWindow,
          applied.deferred,
          hasMore ? null : targetCursor,
        );
      }
    }

    if (window.length > 0) {
      const appliedWindow = window;
      const applied = await this.entryStateApplier.applyManifestWindow(
        store,
        token,
        window,
        {
          finalWindow: true,
          progress: {
            completedOffset: totals.entriesApplied,
            totalEntries,
          },
        },
      );
      totals.entriesApplied += applied.entriesApplied;
      totals.filesWritten += applied.filesWritten;
      totals.filesDeleted += applied.filesDeleted;
      totals.conflictsCreated += applied.conflictsCreated;
      cursor = await this.checkpointAppliedWindow(
        store,
        session,
        cursor,
        appliedWindow,
        applied.deferred,
        targetCursor,
      );
    }

    cursor = targetCursor ?? cursor;
    if (cursor > await store.getCursor()) {
      await store.setCursor(cursor);
      await store.flush();
    }

    return {
      cursor,
      entriesApplied: totals.entriesApplied,
      filesWritten: totals.filesWritten,
      filesDeleted: totals.filesDeleted,
      conflictsCreated: totals.conflictsCreated,
    };
  }

  /**
   * Bring specific entries up to date without moving the pull cursor.
   *
   * A pull only ever sees entries that changed after the cursor. A pending
   * change whose base revision is behind the server can therefore be stuck
   * for good once the cursor has passed the newer revision without this
   * device recording it: the server rejects the change as stale, the pull
   * that follows has nothing to say about that entry, and the change is
   * uploaded again. Fetching the entry by id and running it through the same
   * apply path a pull uses lets the pending-change handling - clear it if the
   * server already has it, merge it, or keep both versions - do exactly what
   * it would have done had the pull delivered it.
   *
   * The cursor is left alone on purpose. It records how far through the
   * change feed this device has read, and reading one entry out of order says
   * nothing about the entries around it.
   */
  async applyEntryStatesById(
    session: SyncRealtimeSession,
    entryIds: string[],
  ): Promise<ApplyEntryStatesByIdResult> {
    const store = this.deps.getSyncStore();
    if (!store) {
      throw new Error("Sync store is not initialized.");
    }

    const token = await this.deps.getSyncToken();
    const states = await session.getEntryStatesById(entryIds);
    const manifest = await this.entryStateApplier.createManifestItems(states);

    const entries = new Map<string, EntryStateByIdOutcome>();
    for (const entryId of entryIds) {
      entries.set(entryId, { status: "missing" });
    }
    for (const state of states) {
      // Overwritten below for every state that decrypted. Whatever is left
      // is a state createManifestItems had to drop.
      entries.set(state.entryId, { status: "undecryptable", revision: state.revision });
    }
    const applicable: PullEntryStateManifestItem[] = [];
    for (const item of manifest) {
      const { state, metadata } = item;
      if (metadata.path && this.deps.shouldApplyRemotePath?.(metadata.path) === false) {
        entries.set(state.entryId, {
          status: "excluded",
          revision: state.revision,
          path: metadata.path,
        });
        continue;
      }
      entries.set(state.entryId, {
        status: "applied",
        revision: state.revision,
        path: metadata.path,
        deleted: state.deleted,
      });
      applicable.push(item);
    }

    // An excluded entry is reported and left out, where a pull would have
    // recorded the server's revision for it. Recording it here would make the
    // next edit of the stuck change build on that revision, which the server
    // then accepts: the other device's version replaced by this one's, at the
    // old path, with no merge and no conflict copy. Leaving it out keeps the
    // change based where it was, so it is rejected and set aside again rather
    // than overwriting anything.
    const applied = await this.entryStateApplier.applyManifest(store, token, applicable);
    await store.flush();
    return { ...applied, entries };
  }

  private async checkpointAppliedWindow(
    store: SyncPullStore,
    session: SyncRealtimeSession,
    currentCursor: number,
    window: PullEntryStateManifestItem[],
    deferred: PullEntryStateManifestItem[],
    finalTargetCursor: number | null,
  ): Promise<number> {
    const safeCursor = getSafeCheckpointCursor(
      currentCursor,
      window,
      deferred,
      finalTargetCursor,
    );
    if (safeCursor <= currentCursor) {
      return currentCursor;
    }

    await store.setCursor(safeCursor);
    await store.flush();
    return safeCursor;
  }
}

export type PullVaultAdapter = PullEntryStateVaultAdapter;

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.floor(value));
}

function getSafeCheckpointCursor(
  currentCursor: number,
  window: PullEntryStateManifestItem[],
  deferred: PullEntryStateManifestItem[],
  finalTargetCursor: number | null,
): number {
  if (deferred.length > 0) {
    const firstDeferredCursor = Math.min(
      ...deferred.map((item) => item.state.updatedSeq),
    );
    return Math.max(currentCursor, firstDeferredCursor - 1);
  }

  if (finalTargetCursor !== null) {
    return Math.max(currentCursor, finalTargetCursor);
  }

  const lastAppliedCursor = Math.max(
    currentCursor,
    ...window.map((item) => item.state.updatedSeq),
  );
  return lastAppliedCursor;
}
