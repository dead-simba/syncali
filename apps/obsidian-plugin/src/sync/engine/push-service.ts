import { isOfflineLikeError } from "../../http/network-status";
import { SyncBlobClient } from "../remote/blob-client";
import type { ConflictFileWriter } from "../core/conflict-file";
import {
  createSyncCryptoContext,
  type SyncCryptoContext,
} from "../core/crypto";
import type { SyncTokenResponse } from "../remote/client";
import type {
  CommitMutationBatchResult,
  SyncRealtimeSession,
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
}

export class SyncPushService {
  /**
   * Consecutive commit failures per mutation. In memory on purpose: a restart
   * genuinely is a fresh chance, and persisting it would keep punishing a file
   * for an outage that has since ended.
   */
  private readonly commitFailures = new Map<string, number>();

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
          shouldPullAfterPush = shouldPullAfterPush || result.shouldPullAfterPush;

          if (result.status === "stale") {
            mutationsRequeued += 1;
            stopAfterCurrentBatch = true;
            continue;
          }
          if (result.status === "requeued") {
            mutationsRequeued += 1;
            continue;
          }
          if (result.status === "conflict") {
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
   * a new network, sometimes a restarted server. If the change fails five more
   * times it is parked again, so this cannot spin - it is a fresh chance, not a
   * retry loop.
   */
  async retryQuarantinedMutations(): Promise<number> {
    const store = this.deps.getSyncStore();
    if (!store) {
      return 0;
    }

    const parked = await store.listBlockedDirtyEntriesByReason("prepare_failed");
    for (const mutation of parked) {
      this.commitFailures.delete(mutation.mutationId);
      await store.updateDirtyEntry({
        ...mutation,
        status: "pending",
        blockedReason: null,
      });
    }
    return parked.length;
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
      prepared: Awaited<ReturnType<PushMutationCommitter["prepareMutationForCommit"]>>;
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
   * Transient failures are rethrown so the existing retry and backoff still
   * apply: a dropped connection must not quarantine a perfectly good file.
   * Anything that would fail identically next attempt is parked with a reason,
   * so the rest of the batch still goes through and the user can be told which
   * file needs attention rather than watching sync stop.
   */
  private async prepareOneOrQuarantine(
    mutationCommitter: PushMutationCommitter,
    store: SyncPushStore,
    token: SyncTokenResponse,
    session: SyncRealtimeSession,
    mutation: PendingMutationRow,
  ): Promise<Awaited<ReturnType<PushMutationCommitter["prepareMutationForCommit"]>>> {
    try {
      return await mutationCommitter.prepareMutationForCommit(
        store,
        token,
        mutation,
        session.maxFileSizeBytes,
      );
    } catch (error) {
      // navigator.onLine is deliberately ignored here: during a real outage it
      // reports offline for everything, and quarantining a file because the
      // wifi dropped would be exactly the wrong call. Only the error text
      // decides whether this is worth retrying.
      if (isOfflineLikeError(error, () => false)) {
        throw error;
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
