import { isOfflineLikeError } from "../../http/network-status";
import { hashBytes } from "../core/content";
import { decryptSyncBlob } from "../core/crypto";
import type { SyncTokenResponse } from "../remote/client";
import type { RemoteEntryState } from "../remote/changes";
import type { SyncPullClient } from "../remote/pull-client";
import type { SyncBlobStore } from "../store/ports";
import { isAutoMergeTextPath } from "./text-merge-policy";
import {
  DEFAULT_PREPARE_CONCURRENCY,
  mapWithConcurrency,
  type PlannedEntryState,
  type PreparedEntryBlob,
  requireBlobId,
} from "./pull-entry-state-internal";

interface PullBlobPreparerDeps {
  getApiBaseUrl: () => string;
  getRemoteVaultKey: () => Uint8Array;
  pullClient: Pick<SyncPullClient, "downloadBlob">;
  prepareConcurrency?: number;
  blobDownloadAttempts?: number;
  blobRetryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_BLOB_DOWNLOAD_ATTEMPTS = 3;
const DEFAULT_BLOB_RETRY_DELAY_MS = 500;

export class PullBlobPreparer {
  constructor(private readonly deps: PullBlobPreparerDeps) {}

  async preparePathBatchBlobs(
    store: SyncBlobStore,
    token: SyncTokenResponse,
    plans: PlannedEntryState[],
  ): Promise<PreparedEntryBlob[]> {
    const blobPlans = plans.filter((plan) => {
      if (!plan.finalPath || plan.state.deleted) {
        return false;
      }
      if (!plan.skipVaultWrite) {
        return true;
      }

      // Same-path adopted entries already have matching local bytes. For non-text
      // files, accepted remote metadata relies on the server's staged/live blob
      // invariant, so a broken invariant would not be caught by client-side
      // download/decrypt/hash verification here. Text files still download so
      // merge bases stay cached locally.
      return plan.adoptedLocalEntry?.hashMatches && isAutoMergeTextPath(plan.finalPath);
    });

    return await mapWithConcurrency(
      blobPlans,
      this.deps.prepareConcurrency ?? DEFAULT_PREPARE_CONCURRENCY,
      async (plan) => {
        return {
          plan,
          bytes: await this.downloadAndVerifyEntryBlobWithRetry(store, token, plan),
        };
      },
    );
  }

  private async downloadEntryBlob(
    token: SyncTokenResponse,
    state: RemoteEntryState,
  ): Promise<Uint8Array> {
    if (!state.blobId) {
      throw new Error(`Entry state ${state.entryId}@${state.revision} is missing a blob.`);
    }

    return await this.deps.pullClient.downloadBlob(
      this.deps.getApiBaseUrl(),
      token.token,
      token.vaultId,
      state.blobId,
    );
  }

  /**
   * Retries a blob download that failed for transport reasons.
   *
   * A window is prepared in full before anything is written, so a single failed
   * download discards the whole window - every other entry in it is re-fetched
   * from scratch on the next attempt, and the sync cursor never advances. On a
   * high-latency mobile link that is fatal rather than merely wasteful: with
   * hundreds of entries per window, the odds that all of their downloads
   * succeed on the same attempt approach zero, so the pull can never converge
   * and the user sits at "99%" forever.
   *
   * Android's HTTP stack makes this routine. It reuses pooled keep-alive
   * connections the server has already closed and reads an immediate EOF,
   * reported as `IOException: unexpected end of stream` - which a retry on a
   * fresh connection resolves outright.
   *
   * Only transport failures are retried. A hash mismatch means the bytes are
   * wrong, not late, and must still fail the window immediately.
   */
  private async downloadAndVerifyEntryBlobWithRetry(
    store: SyncBlobStore,
    token: SyncTokenResponse,
    plan: PlannedEntryState,
  ): Promise<Uint8Array> {
    const attempts = Math.max(1, this.deps.blobDownloadAttempts ?? DEFAULT_BLOB_DOWNLOAD_ATTEMPTS);
    const delayMs = this.deps.blobRetryDelayMs ?? DEFAULT_BLOB_RETRY_DELAY_MS;
    const sleep =
      this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.downloadAndVerifyEntryBlob(store, token, plan);
      } catch (error) {
        lastError = error;
        // `isOfflineLikeError` consults navigator.onLine, which reports offline
        // for the duration of a real outage - retrying then would burn the
        // budget on attempts that cannot succeed. Only the error text matters.
        if (!isOfflineLikeError(error, () => false) || attempt === attempts - 1) {
          throw error;
        }

        await sleep(delayMs * 2 ** attempt);
      }
    }

    throw lastError;
  }

  private async downloadAndVerifyEntryBlob(
    store: SyncBlobStore,
    token: SyncTokenResponse,
    plan: PlannedEntryState,
  ): Promise<Uint8Array> {
    const blobId = requireBlobId(plan.state);
    const encryptedBytes = await this.downloadEntryBlob(token, plan.state);
    const bytes = await decryptSyncBlob(
      this.deps.getRemoteVaultKey(),
      encryptedBytes,
      { blobId },
      { syncFormatVersion: token.syncFormatVersion },
    );
    const actualHash = await hashBytes(bytes);
    if (actualHash !== plan.hash) {
      throw new Error(
        `Entry state ${plan.state.entryId}@${plan.state.revision} hash does not match metadata.`,
      );
    }
    if (plan.finalPath && isAutoMergeTextPath(plan.finalPath)) {
      await store.putBlob({
        blobId,
        hash: actualHash,
        encryptedBytes,
        role: "remote",
        refEntryId: plan.state.entryId,
        cachedAt: Date.now(),
      });
    }

    return bytes;
  }
}
