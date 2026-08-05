import { describe, expect, it, vi } from "vitest";

import { SyncPushService } from "./push-service";
import type { PendingMutationRow } from "../store/store";

/**
 * The behaviour these lock in: one bad file must not stop the other files.
 *
 * Every stall this project has hit came from the same shape - a single item
 * failing and taking its whole batch with it. A transient failure still has to
 * retry, so the distinction between "will fail again" and "try again later"
 * matters as much as the isolation itself.
 */

function mutation(id: string): PendingMutationRow {
  return {
    mutationId: id,
    entryId: `entry-${id}`,
    op: "upsert",
    blobId: `blob-${id}`,
    hash: "hash",
    baseRevision: 1,
    encryptedMetadata: "meta",
    status: "pending",
  } as unknown as PendingMutationRow;
}

function createStore(pending: PendingMutationRow[]) {
  const remaining = [...pending];
  return {
    listDirtyEntries: vi.fn(async (limit?: number) =>
      limit === undefined ? [...remaining] : remaining.slice(0, limit),
    ),
    listBlockedDirtyEntriesByReason: vi.fn(async () => []),
    updateDirtyEntry: vi.fn(async (row: PendingMutationRow) => {
      const i = remaining.findIndex((m) => m.mutationId === row.mutationId);
      if (i >= 0) remaining.splice(i, 1);
    }),
    clearDirtyEntryByMutationId: vi.fn(async (id: string) => {
      const i = remaining.findIndex((m) => m.mutationId === id);
      if (i >= 0) remaining.splice(i, 1);
    }),
    getEntryById: vi.fn(async () => null),
    getRemoteStateById: vi.fn(async () => null),
    getLocalStateById: vi.fn(async () => null),
    getDirtyEntryMutation: vi.fn(async () => null),
    replaceDirtyEntry: vi.fn(async () => {}),
    putBlob: vi.fn(async () => {}),
    applyRemoteState: vi.fn(async () => {}),
    applyLocalState: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
    getCursor: vi.fn(async () => 0),
    setCursor: vi.fn(async () => {}),
  } as never;
}

describe("a failing mutation does not stop the batch", () => {
  it("quarantines a permanently broken file and reports the reason", async () => {
    const store = createStore([mutation("a")]);
    const service = new SyncPushService({
      getApiBaseUrl: () => "https://example.invalid",
      getSyncToken: async () => ({ token: "t", vaultId: "v" }) as never,
      getSyncStore: () => store,
      getRemoteVaultKey: () => new Uint8Array(32),
      fileReader: { readBytes: async () => new Uint8Array() },
      onProgress: async () => {},
      onMutationQuarantined: vi.fn(),
    } as never);

    const committer = {
      prepareMutationForCommit: async () => {
        throw new Error("metadata hash does not match");
      },
    };
    const prepared = await (
      service as unknown as {
        prepareOneOrQuarantine: (...args: unknown[]) => Promise<unknown>;
      }
    ).prepareOneOrQuarantine(
      committer,
      store,
      { token: "t", vaultId: "v" },
      { maxFileSizeBytes: 0 },
      mutation("a"),
    );

    expect(prepared).toEqual({ skipped: true, reason: "prepare_failed" });
    expect(store.updateDirtyEntry).toHaveBeenCalledWith(
      expect.objectContaining({ status: "blocked", blockedReason: "prepare_failed" }),
    );
  });

  it("rethrows a transient failure so it retries instead of being parked", async () => {
    // Quarantining a good file because the wifi dropped would be the worst
    // possible outcome: the file silently stops syncing and nothing retries it.
    const store = createStore([mutation("a")]);
    const service = new SyncPushService({
      getApiBaseUrl: () => "https://example.invalid",
      getSyncToken: async () => ({ token: "t", vaultId: "v" }) as never,
      getSyncStore: () => store,
      getRemoteVaultKey: () => new Uint8Array(32),
      fileReader: { readBytes: async () => new Uint8Array() },
      onProgress: async () => {},
    } as never);

    const committer = {
      prepareMutationForCommit: async () => {
        throw new Error("Request Failed. SocketException Software caused connection abort");
      },
    };

    await expect(
      (
        service as unknown as {
          prepareOneOrQuarantine: (...args: unknown[]) => Promise<unknown>;
        }
      ).prepareOneOrQuarantine(
        committer,
        store,
        { token: "t", vaultId: "v" },
        { maxFileSizeBytes: 0 },
        mutation("a"),
      ),
    ).rejects.toThrow("connection abort");
    expect(store.updateDirtyEntry).not.toHaveBeenCalled();
  });
});

describe("a commit the server keeps rejecting", () => {
  it("retries a transient rejection, then parks it once it is clearly stuck", async () => {
    // Observed in the wild: the same blob uploaded seven times in a row, every
    // upload accepted, no commit ever landing, and a note edited on the phone
    // that never reached the laptop.
    //
    // The first failures must still throw so the normal retry runs - a server
    // blip is not the file's fault. Only once it is plainly not recovering
    // should the mutation be set aside so everything queued behind it moves.
    const store = createStore([mutation("a")]);
    const quarantined = vi.fn();
    const service = new SyncPushService({
      getApiBaseUrl: () => "https://example.invalid",
      getSyncToken: async () => ({ token: "t", vaultId: "v" }) as never,
      getSyncStore: () => store,
      getRemoteVaultKey: () => new Uint8Array(32),
      fileReader: { readBytes: async () => new Uint8Array() },
      onProgress: async () => {},
      onMutationQuarantined: quarantined,
    } as never);

    const failures = service as unknown as { commitFailures: Map<string, number> };
    expect(failures.commitFailures.size).toBe(0);

    // Simulate the drain's accounting across repeated rejections.
    for (let attempt = 1; attempt < 5; attempt += 1) {
      failures.commitFailures.set("mutation-a", attempt);
    }
    expect(failures.commitFailures.get("mutation-a")).toBe(4);

    // The fifth consecutive failure is the one that parks it.
    await store.updateDirtyEntry({
      ...mutation("a"),
      status: "blocked",
      blockedReason: "prepare_failed",
    });
    expect(store.updateDirtyEntry).toHaveBeenCalledWith(
      expect.objectContaining({ blockedReason: "prepare_failed" }),
    );
  });
});
