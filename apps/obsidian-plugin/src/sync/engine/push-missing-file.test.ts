import { describe, expect, it, vi } from "vitest";

import { PushMutationPreparer } from "./push-mutation-preparer";
import type { PendingMutationRow } from "../store/store";

const VAULT_KEY = new Uint8Array(32).fill(3);

vi.mock("../core/crypto", () => ({
  decryptSyncMetadata: async () => ({ path: "Notes/moved.md", hash: "hash-1" }),
  encryptSyncBlob: async (_k: unknown, b: Uint8Array) => b,
  encryptSyncMetadata: async () => "encrypted",
  createSyncCryptoContext: () => ({
    decryptMetadata: async () => ({ path: "Notes/moved.md", hash: "hash-1" }),
    encryptMetadata: async () => "encrypted",
    encryptBlob: async (b: Uint8Array) => b,
    decryptBlob: async (b: Uint8Array) => b,
  }),
}));
vi.mock("../core/content", () => ({ hashBytes: async () => "hash-1" }));

function createMutation(): PendingMutationRow {
  return {
    mutationId: "mutation-1",
    entryId: "entry-1",
    op: "upsert",
    blobId: "blob-1",
    hash: "hash-1",
    baseRevision: 1,
    encryptedMetadata: "encrypted",
  } as unknown as PendingMutationRow;
}

function createStore() {
  return {
    clearDirtyEntryByMutationId: vi.fn(async () => {}),
    getEntryById: vi.fn(async () => null),
    getRemoteStateById: vi.fn(async () => null),
    getLocalStateById: vi.fn(async () => null),
    replaceDirtyEntry: vi.fn(async () => {}),
    updateDirtyEntry: vi.fn(async () => {}),
    getDirtyEntryMutation: vi.fn(async () => null),
    putBlob: vi.fn(async () => {}),
    applyRemoteState: vi.fn(async () => {}),
    applyLocalState: vi.fn(async () => {}),
  } as never;
}

function createPreparer(readBytes: () => Promise<Uint8Array>) {
  return new PushMutationPreparer({
    getApiBaseUrl: () => "https://example.invalid",
    getRemoteVaultKey: () => VAULT_KEY,
    fileReader: { readBytes },
    blobClient: { uploadBlob: vi.fn(async () => {}) },
  } as never);
}

const token = { token: "t", vaultId: "v", syncFormatVersion: 2 } as never;

describe("push with a file that has gone", () => {
  it.each([
    "ENOENT: no such file or directory, open 'Notes/moved.md'",
    "File does not exist",
    "no such file",
  ])("drops the stale upsert instead of failing the batch: %s", async (message) => {
    // A rename or delete between queueing and draining leaves the mutation
    // pointing at a path that no longer exists. Because a push prepares the
    // whole batch before committing any of it, throwing here stopped sync
    // entirely until the user worked out which file had moved.
    const store = createStore();
    const preparer = createPreparer(async () => {
      throw new Error(message);
    });

    const result = await preparer.prepareMutationForCommit(store, token, createMutation(), 0);

    expect(result).toBeNull();
    expect(store.clearDirtyEntryByMutationId).toHaveBeenCalledWith("mutation-1");
  });

  it("still surfaces a read failure that is not a missing file", async () => {
    // A permissions problem or a corrupt read is not stale state, and silently
    // dropping the mutation there would lose the user's change.
    const store = createStore();
    const preparer = createPreparer(async () => {
      throw new Error("EACCES: permission denied");
    });

    await expect(
      preparer.prepareMutationForCommit(store, token, createMutation(), 0),
    ).rejects.toThrow("EACCES");
    expect(store.clearDirtyEntryByMutationId).not.toHaveBeenCalled();
  });
});
