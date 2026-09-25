import { expect, vi } from "vitest";

import { encodeUtf8, hashBytes } from "../../../core/content";
import { encryptSyncMetadata } from "../../../core/crypto";
import type { RemoteEntryState } from "../../../remote/changes";
import {
  type CommitMutationBatchResult,
  SYNC_FEATURE_GET_ENTRY_STATES,
  type SyncRealtimeSession,
} from "../../../remote/realtime-client";
import type { SyncStore } from "../../../store/store";
import { createInitializedTestSyncStore } from "../../../../test-support/test-plugin";
import { SyncPullService } from "../../pull-service";
import { SyncPushService } from "../../push-service";
import {
  StaleMutationUnresolvedError,
  type StaleRecoveryEvent,
} from "../../push-stale-recovery";
import {
  arrangePendingUpsertWithCachedBase,
  createPullClient,
  createToken,
  createVaultAdapter,
  encryptPendingMetadata,
  encryptRemoteMetadata,
  encryptTestBlob,
  ignoreProgress,
  TEST_VAULT_KEY,
} from "../pull-service/helpers";

/**
 * The note from the desktop capture, and just enough of the server to
 * reproduce what happened to it. Shared by the tests for a change the server
 * keeps rejecting as out of date and for uploads that fail on their own.
 */

export const ENTRY_ID = "a72c4a5a-29ef-44bf-b74a-cbe420a6fc5e";
export const PATH = "Notes/The Lean Startup.md";
export const BASE_TEXT = "# The Lean Startup\n\nBuild, measure, learn.\n\nnotes\n";
export const LOCAL_TEXT = "# The Lean Startup\n\nBuild, measure, learn.\n\nnotes, edited here\n";
export const REMOTE_TEXT = "# The Lean Startup (Ries)\n\nBuild, measure, learn.\n\nnotes\n";
export const MERGED_TEXT =
  "# The Lean Startup (Ries)\n\nBuild, measure, learn.\n\nnotes, edited here\n";
export const MAX_UPLOADS = 4;

/**
 * Enough of the server to reproduce the loop: stale rejections that name both
 * revisions, a change feed read from a cursor, and fetching one entry by id
 * when the session advertises it.
 */
export class FakeServer {
  readonly entries = new Map<string, RemoteEntryState>();
  readonly uploads: string[] = [];
  readonly commitBases: number[] = [];
  readonly listedSince: number[] = [];
  readonly fetchedById: string[][] = [];
  cursor = 0;
  /** Another device writing to the same note while this one is stuck. */
  bumpRevisionOnReject: (() => Promise<void>) | null = null;
  /** An upload the server fails, every time, for reasons of its own. */
  failUpload: ((blobId: string) => Error | null) | null = null;
  /** A lookup by id the server answers with an error instead of the entries. */
  failEntryStatesById: Error | null = null;
  /** How many lookups fail that way before the server recovers. */
  failEntryStatesByIdTimes = Number.POSITIVE_INFINITY;

  constructor(private readonly features: string[]) {}

  readonly blobClient = {
    uploadBlob: async (
      _apiBaseUrl: string,
      _token: string,
      _vaultId: string,
      blobId: string,
    ) => {
      this.uploads.push(blobId);
      const failure = this.failUpload?.(blobId);
      if (failure) {
        throw failure;
      }
    },
  };

  put(state: Omit<RemoteEntryState, "updatedSeq" | "updatedAt">, updatedSeq: number): void {
    this.entries.set(state.entryId, { ...state, updatedSeq, updatedAt: updatedSeq });
    this.cursor = Math.max(this.cursor, updatedSeq);
  }

  session(): SyncRealtimeSession {
    return {
      serverCursor: this.cursor,
      features: this.features,
      storageUsedBytes: 0,
      storageLimitBytes: 100_000_000,
      maxFileSizeBytes: 3_000_000,
      watchStorageStatus() {},
      unwatchStorageStatus() {},
      listEntryStates: async ({ sinceCursor }) => {
        this.listedSince.push(sinceCursor);
        const entries = [...this.entries.values()].filter(
          (entry) => entry.updatedSeq > sinceCursor,
        );
        return {
          targetCursor: this.cursor,
          totalEntries: entries.length,
          hasMore: false,
          nextAfter: null,
          entries,
        };
      },
      getEntryStatesById: async (entryIds) => {
        // An old server would answer with a session error that fails every
        // request in flight. Reaching here without the feature is a bug.
        if (!this.features.includes(SYNC_FEATURE_GET_ENTRY_STATES)) {
          throw new Error("get_entry_states sent to a server that did not advertise it");
        }
        this.fetchedById.push(entryIds);
        if (this.failEntryStatesById && this.failEntryStatesByIdTimes > 0) {
          this.failEntryStatesByIdTimes -= 1;
          throw this.failEntryStatesById;
        }
        return entryIds.flatMap((entryId) => {
          const entry = this.entries.get(entryId);
          return entry ? [entry] : [];
        });
      },
      commitMutations: async (mutations) => {
        const results: CommitMutationBatchResult[] = [];
        for (const mutation of mutations) {
          this.commitBases.push(mutation.baseRevision);
          const current = this.entries.get(mutation.entryId)?.revision ?? 0;
          if (mutation.baseRevision !== current) {
            results.push({
              status: "rejected",
              mutationId: mutation.mutationId,
              entryId: mutation.entryId,
              code: "stale_revision",
              message: `expected base revision ${current} but received ${mutation.baseRevision}`,
              expectedBaseRevision: current,
              receivedBaseRevision: mutation.baseRevision,
            });
            await this.bumpRevisionOnReject?.();
            continue;
          }

          this.cursor += 1;
          this.put(
            {
              entryId: mutation.entryId,
              revision: current + 1,
              blobId: mutation.blobId,
              encryptedMetadata: mutation.encryptedMetadata,
              deleted: mutation.op === "delete",
            },
            this.cursor,
          );
          results.push({
            status: "accepted",
            mutationId: mutation.mutationId,
            cursor: this.cursor,
            entryId: mutation.entryId,
            revision: current + 1,
          });
        }
        return { cursor: this.cursor, results };
      },
      async commitMutation() {
        throw new Error("the push service commits in batches");
      },
      async listEntryVersions() {
        throw new Error("not used");
      },
      async listDeletedEntries() {
        throw new Error("not used");
      },
      async restoreEntryVersion() {
        throw new Error("not used");
      },
      async restoreEntryVersions() {
        throw new Error("not used");
      },
      async purgeDeletedEntries() {
        throw new Error("not used");
      },
      async detachLocalVault() {},
      close() {},
    };
  }
}

export async function arrange(input: {
  features: string[];
  localCursor: number;
  remote: {
    revision: number;
    updatedSeq: number;
    path?: string;
    /** Metadata sealed with some other key: it will not decrypt here. */
    undecryptable?: boolean;
  };
  shouldApplyRemotePath?: (path: string) => boolean;
  /** Queue a delete of the note instead of an edit to it. */
  pendingOp?: "upsert" | "delete";
}) {
  const store = await createInitializedTestSyncStore();
  const adapter = createVaultAdapter({ [PATH]: LOCAL_TEXT });
  const baseHash = await hashBytes(encodeUtf8(BASE_TEXT));
  const localHash = await hashBytes(encodeUtf8(LOCAL_TEXT));
  const remoteHash = await hashBytes(encodeUtf8(REMOTE_TEXT));

  // The device's recorded state, as decoded from its IndexedDB: one dirty
  // entry, an upsert based on revision 1, and remote revision 1 recorded.
  await arrangePendingUpsertWithCachedBase(store, {
    entryId: ENTRY_ID,
    path: PATH,
    baseRevision: 1,
    baseBlobId: "blob-base",
    baseHash,
    baseBytes: encodeUtf8(BASE_TEXT),
    localBlobId: "blob-local",
    localHash,
    createdAt: 2,
    mutationId: "mutation-stuck",
  });
  if (input.pendingOp === "delete") {
    // The same note, deleted here instead of edited.
    await adapter.remove(PATH);
    await store.applyLocalState({
      entryId: ENTRY_ID,
      path: PATH,
      blobId: null,
      hash: null,
      deleted: true,
      updatedAt: 3,
      localMtime: null,
      localSize: null,
    });
    await store.replaceDirtyEntry({
      mutationId: "mutation-stuck",
      entryId: ENTRY_ID,
      op: "delete",
      baseRevision: 1,
      baseBlobId: "blob-base",
      baseHash,
      blobId: null,
      hash: null,
      encryptedMetadata: await encryptPendingMetadata({
        entryId: ENTRY_ID,
        baseRevision: 1,
        op: "delete",
        blobId: null,
        path: PATH,
      }),
      createdAt: 3,
    });
  }
  await store.setCursor(input.localCursor);

  const server = new FakeServer(input.features);
  const remotePath = input.remote.path ?? PATH;
  server.put(
    {
      entryId: ENTRY_ID,
      revision: input.remote.revision,
      blobId: "blob-remote",
      encryptedMetadata: input.remote.undecryptable
        ? await encryptSyncMetadata(
            new Uint8Array(32).fill(9),
            { path: remotePath, hash: remoteHash },
            {
              entryId: ENTRY_ID,
              revision: input.remote.revision,
              op: "upsert",
              blobId: "blob-remote",
            },
          )
        : await encryptRemoteMetadata({
            entryId: ENTRY_ID,
            revision: input.remote.revision,
            blobId: "blob-remote",
            path: remotePath,
            hash: remoteHash,
          }),
      deleted: false,
    },
    input.remote.updatedSeq,
  );

  const quarantined: Array<{ entryId: string; mutationId: string; error: unknown }> = [];
  const recovered: StaleRecoveryEvent[] = [];
  const undecryptable = vi.fn();
  const pullService = new SyncPullService({
    getApiBaseUrl: () => "http://127.0.0.1:8787",
    getSyncToken: async () => createToken(),
    getSyncStore: () => store,
    getRemoteVaultKey: () => TEST_VAULT_KEY,
    shouldApplyRemotePath: input.shouldApplyRemotePath,
    onUndecryptableEntry: undecryptable,
    vaultAdapter: adapter,
    pullClient: createPullClient({
      blobs: {
        "blob-remote": await encryptTestBlob("blob-remote", encodeUtf8(REMOTE_TEXT)),
      },
    }),
    onProgress: ignoreProgress,
  });
  const pushService = new SyncPushService({
    getApiBaseUrl: () => "http://127.0.0.1:8787",
    getSyncToken: async () => createToken(),
    getSyncStore: () => store,
    getRemoteVaultKey: () => TEST_VAULT_KEY,
    fileReader: adapter,
    conflictFileWriter: adapter,
    blobClient: server.blobClient as never,
    onProgress: ignoreProgress,
    onMutationQuarantined: (event) => quarantined.push(event),
    applyEntryStatesById: async (session, entryIds) =>
      await pullService.applyEntryStatesById(session, entryIds),
    onStaleRecovery: (event) => recovered.push(event),
  });

  return {
    store,
    adapter,
    server,
    pushService,
    pullService,
    quarantined,
    recovered,
    undecryptable,
    remoteHash,
  };
}

export type StaleContext = Awaited<ReturnType<typeof arrange>>;

/**
 * What the auto-sync drain does, minus the timers: push, pull when the push
 * asks for it, and go round again while anything is queued. Twenty passes is
 * far past where the bound should have stopped it - before the fix, each one
 * was another upload. `betweenPasses` runs after each pass's pull, where an
 * autosave or another device's write would land.
 */
export async function drain(
  context: StaleContext,
  passes = 20,
  betweenPasses?: (pass: number) => Promise<void>,
): Promise<void> {
  const session = context.server.session();
  for (let pass = 0; pass < passes; pass += 1) {
    const pushed = await context.pushService.pushPendingMutations(session);
    if (pushed.shouldPullAfterPush) {
      await context.pullService.pullOnce(session);
    }
    if (!pushed.hasMore) {
      return;
    }
    await betweenPasses?.(pass);
  }
}

export async function expectParkedWithEditKept(
  context: StaleContext,
  store: SyncStore,
) {
  expect(await store.listDirtyEntries()).toEqual([]);
  expect(await store.getDirtyEntryMutation(ENTRY_ID)).toMatchObject({
    mutationId: "mutation-stuck",
    baseRevision: 1,
    status: "blocked",
    blockedReason: "stale_unresolved",
  });
  expect(context.adapter.text(PATH)).toBe(LOCAL_TEXT);
  expect(context.quarantined).toHaveLength(1);
  const error = context.quarantined[0]?.error;
  expect(error).toBeInstanceOf(StaleMutationUnresolvedError);
  return (error as StaleMutationUnresolvedError).event;
}
