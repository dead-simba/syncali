import { describe, expect, it, vi } from "vitest";

import { PullBlobPreparer } from "./pull-blob-preparer";
import type { PlannedEntryState } from "./pull-entry-state-internal";

const VAULT_KEY = new Uint8Array(32).fill(7);

vi.mock("../core/crypto", () => ({
  decryptSyncBlob: async (_key: unknown, bytes: Uint8Array) => bytes,
}));
vi.mock("../core/content", () => ({
  hashBytes: async () => "hash-1",
}));

function createPlan(): PlannedEntryState {
  return {
    state: { entryId: "entry-1", revision: 1, blobId: "blob-1", deleted: false },
    metadata: { path: "Notes/note.md" },
    finalPath: "Notes/note.md",
    hash: "hash-1",
    skipVaultWrite: false,
  } as unknown as PlannedEntryState;
}

function createPreparer(downloadBlob: () => Promise<Uint8Array>) {
  return new PullBlobPreparer({
    getApiBaseUrl: () => "https://example.invalid",
    getRemoteVaultKey: () => VAULT_KEY,
    pullClient: { downloadBlob },
    sleep: async () => {},
  });
}

const store = { putBlob: async () => {} } as never;
const token = { token: "t", vaultId: "v", syncFormatVersion: 2 } as never;

describe("blob download retry", () => {
  it("recovers from Android's stale pooled connection", async () => {
    // OkHttp reuses a keep-alive connection the server already closed and reads
    // an immediate EOF. A retry opens a fresh connection and succeeds.
    let calls = 0;
    const preparer = createPreparer(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error(
          "Request Failed. IOException unexpected end of stream on com.android.okhttp.Address@7bd5dc6f",
        );
      }
      return new Uint8Array([1, 2, 3]);
    });

    const prepared = await preparer.preparePathBatchBlobs(store, token, [createPlan()]);

    expect(calls).toBe(2);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("gives up after the attempt budget so a real outage still fails", async () => {
    let calls = 0;
    const preparer = createPreparer(async () => {
      calls += 1;
      throw new Error("Software caused connection abort");
    });

    await expect(
      preparer.preparePathBatchBlobs(store, token, [createPlan()]),
    ).rejects.toThrow("Software caused connection abort");
    expect(calls).toBe(3);
  });

  it("does not retry a hash mismatch", async () => {
    // Wrong bytes are wrong, not late - retrying would mask corruption.
    let calls = 0;
    const preparer = createPreparer(async () => {
      calls += 1;
      return new Uint8Array([9, 9, 9]);
    });
    const plan = createPlan();
    (plan as { hash: string }).hash = "different-hash";

    await expect(preparer.preparePathBatchBlobs(store, token, [plan])).rejects.toThrow(
      /did not match its expected contents/,
    );
    expect(calls).toBe(1);
  });
});
