import { SyncBlobClient, SyncBlobUploadError } from "../remote/blob-client";
import { hashBytes } from "../core/content";
import {
  createSyncCryptoContext,
  type SyncCryptoContext,
} from "../core/crypto";
import { queueLocalUpsertMutation } from "../core/mutation-queue";
import type { SyncTokenResponse } from "../remote/client";
import type { PendingMutationRow } from "../store/store";
import type {
  PreparePushMutationResult,
  PushMutationCommitterDeps,
  PushMutationStore,
} from "./push-mutation-types";
import {
  metadataContextFromMutation,
  toCommitPayload,
} from "./push-mutation-shared";

export class PushMutationPreparer {
  private readonly blobClient: SyncBlobClient;
  private fallbackCryptoContext: SyncCryptoContext | null = null;

  constructor(private readonly deps: PushMutationCommitterDeps) {
    this.blobClient = deps.blobClient ?? new SyncBlobClient();
  }

  async prepareMutationForCommit(
    store: PushMutationStore,
    token: SyncTokenResponse,
    mutation: PendingMutationRow,
    maxFileSizeBytes: number,
    storageAvailableBytes: number | null = null,
  ): Promise<PreparePushMutationResult> {
    const syncCrypto = this.getSyncCryptoContext();
    const metadata = await syncCrypto.decryptMetadata(
      mutation.encryptedMetadata,
      metadataContextFromMutation(mutation),
    );

    if (mutation.op === "delete") {
      return {
        commitPayload: toCommitPayload(mutation),
        metadata,
        localHash: null,
        encryptedBytes: null,
        storageBytesAdded: 0,
      };
    }

    // A queued upsert can outlive the file it points at: renaming, moving or
    // deleting a note between the change being recorded and the push draining
    // leaves the mutation pointing at a path that no longer exists. Reading it
    // unguarded threw, and because a push prepares a whole batch before
    // committing any of it, one moved file stopped the entire sync.
    //
    // The mutation is simply stale. Drop it and let the rename or delete event
    // that superseded it carry the change instead - the same treatment the
    // hash-changed case below already gets.
    let bytes: Uint8Array;
    try {
      bytes = await this.deps.fileReader.readBytes(metadata.path);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }

      await store.clearDirtyEntryByMutationId(mutation.mutationId);
      return null;
    }
    if (!mutation.blobId) {
      throw new Error(`Upsert mutation ${mutation.mutationId} is missing a blobId.`);
    }
    if (!mutation.hash) {
      throw new Error(`Upsert mutation ${mutation.mutationId} is missing a hash.`);
    }
    if (metadata.hash !== mutation.hash) {
      throw new Error(`Upsert mutation ${mutation.mutationId} metadata hash does not match.`);
    }
    const actualHash = await hashBytes(bytes);
    if (actualHash !== mutation.hash) {
      await this.requeueChangedUpsert(store, mutation, metadata.path, actualHash);
      return null;
    }
    const blobId = mutation.blobId;
    const encryptedBytes = await syncCrypto.encryptBlob(bytes, { blobId }, {
      syncFormatVersion: token.syncFormatVersion,
    });
    const storageBytesAdded =
      mutation.blobId === mutation.baseBlobId && mutation.hash === mutation.baseHash
        ? 0
        : encryptedBytes.byteLength;
    if (maxFileSizeBytes > 0 && encryptedBytes.byteLength > maxFileSizeBytes) {
      await this.blockOversizedUpsert(
        store,
        mutation,
        encryptedBytes.byteLength,
        maxFileSizeBytes,
      );
      return {
        skipped: true,
        reason: "file_too_large",
      };
    }
    if (
      storageAvailableBytes !== null &&
      storageBytesAdded > storageAvailableBytes
    ) {
      return {
        skipped: true,
        reason: "storage_quota_exceeded",
      };
    }

    try {
      await this.blobClient.uploadBlob(
        this.deps.getApiBaseUrl(),
        token.token,
        token.vaultId,
        blobId,
        encryptedBytes,
      );
    } catch (error) {
      if (isQuotaExceededUploadError(error)) {
        return {
          skipped: true,
          reason: "storage_quota_exceeded",
        };
      }
      if (isFileTooLargeUploadError(error)) {
        await this.blockOversizedUpsert(
          store,
          mutation,
          encryptedBytes.byteLength,
          maxFileSizeBytes > 0 ? maxFileSizeBytes : null,
        );
        return {
          skipped: true,
          reason: "file_too_large",
        };
      }

      throw error;
    }

    return {
      commitPayload: {
        mutationId: mutation.mutationId,
        entryId: mutation.entryId,
        op: mutation.op,
        baseRevision: mutation.baseRevision,
        blobId,
        encryptedMetadata: mutation.encryptedMetadata,
      },
      metadata,
      localHash: mutation.hash,
      encryptedBytes,
      storageBytesAdded,
    };
  }

  private getSyncCryptoContext(): SyncCryptoContext {
    if (this.deps.getSyncCryptoContext) {
      return this.deps.getSyncCryptoContext();
    }

    this.fallbackCryptoContext ??= createSyncCryptoContext(this.deps.getRemoteVaultKey());
    return this.fallbackCryptoContext;
  }

  private async blockOversizedUpsert(
    store: PushMutationStore,
    mutation: PendingMutationRow,
    encryptedSizeBytes: number,
    maxFileSizeBytes: number | null,
  ): Promise<void> {
    await store.updateDirtyEntry({
      ...mutation,
      status: "blocked",
      blockedReason: "file_too_large",
      blockedEncryptedSizeBytes: encryptedSizeBytes,
      blockedMaxFileSizeBytes: maxFileSizeBytes,
    });
  }

  private async requeueChangedUpsert(
    store: PushMutationStore,
    mutation: PendingMutationRow,
    path: string,
    hash: string,
  ): Promise<void> {
    const existing = await store.getEntryById(mutation.entryId);
    const remote = await store.getRemoteStateById(mutation.entryId);
    const local = await store.getLocalStateById(mutation.entryId);
    const queued = await queueLocalUpsertMutation(store, {
      remoteVaultKey: this.deps.getRemoteVaultKey(),
      path,
      entryId: mutation.entryId,
      base: remote ?? {
        revision: mutation.baseRevision,
        deleted: false,
        blobId: mutation.baseBlobId ?? mutation.blobId,
        hash: mutation.baseHash ?? mutation.hash,
      },
      previousLocal: local ?? existing,
      hash,
    });

    await store.applyLocalState({
      entryId: queued.entryId,
      path,
      blobId: queued.blobId,
      hash,
      deleted: false,
      updatedAt: Date.now(),
      localMtime: existing?.localMtime ?? null,
      localSize: existing?.localSize ?? null,
    });
  }
}

function isQuotaExceededUploadError(error: unknown): boolean {
  return (
    error instanceof SyncBlobUploadError &&
    error.status === 413 &&
    error.code === "quota_exceeded"
  );
}

function isFileTooLargeUploadError(error: unknown): boolean {
  return (
    error instanceof SyncBlobUploadError &&
    error.status === 413 &&
    error.code !== "quota_exceeded"
  );
}

/**
 * Whether a read failed because the file is gone.
 *
 * Obsidian's desktop adapter surfaces node's ENOENT, while the mobile adapter
 * reports a worded message from the platform layer, so both shapes are matched
 * rather than relying on an error code being present.
 */
function isMissingFileError(error: unknown): boolean {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
    return true;
  }

  const message = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  return (
    message.includes("enoent") ||
    message.includes("no such file") ||
    message.includes("file does not exist") ||
    message.includes("does not exist")
  );
}
