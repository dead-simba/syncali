import { describe, expect, it, vi } from "vitest";

import { decryptDeviceReportDetails, encryptDeviceReportDetails } from "../core/crypto";
import { VaultWriteError } from "../vault/vault-writer";
import { SyncHealthTracker } from "./health-tracker";
import { classifySyncError } from "./problem-kind";

function createStore(initial?: unknown) {
  let stored = initial;
  return {
    initialize: vi.fn(async () => {}),
    read: vi.fn(() => stored),
    write: vi.fn((_key: string, value: unknown) => {
      stored = value;
    }),
    save: vi.fn(async () => {}),
    get stored() {
      return stored;
    },
  };
}

describe("the sync health tracker", () => {
  it("counts each kind of problem with when it started and when it last happened", () => {
    let now = 1_000;
    const tracker = new SyncHealthTracker(createStore() as never, () => now);
    tracker.recordProblem("name_refused");
    now = 5_000;
    tracker.recordProblem("name_refused");

    expect(tracker.snapshot()).toMatchObject({
      lastErrorAt: 5_000,
      problems: { name_refused: { count: 2, firstAt: 1_000, lastAt: 5_000 } },
    });
  });

  it("does not treat a conflict as an error", () => {
    const tracker = new SyncHealthTracker(createStore() as never, () => 1_000);
    tracker.recordProblem("conflict");

    expect(tracker.snapshot().lastErrorAt).toBeNull();
  });

  it("keeps the furthest server cursor it has seen", () => {
    const tracker = new SyncHealthTracker(createStore() as never);
    tracker.recordServerCursor(10);
    tracker.recordServerCursor(7);

    expect(tracker.snapshot().serverCursor).toBe(10);
  });

  it("survives a restart", async () => {
    const store = createStore();
    const tracker = new SyncHealthTracker(store as never, () => 2_000);
    tracker.markActive();
    tracker.recordSyncOk();
    tracker.recordProblem("set_aside");
    await tracker.persist();

    const reopened = new SyncHealthTracker(createStore(store.stored) as never);
    reopened.load();

    expect(reopened.snapshot()).toEqual({
      activeSince: 2_000,
      lastSyncOkAt: 2_000,
      lastErrorAt: 2_000,
      serverCursor: null,
      problems: { set_aside: { count: 1, firstAt: 2_000, lastAt: 2_000 } },
    });
  });

  it("warns about a stuck device once a day, not every half hour", () => {
    let now = 0;
    const tracker = new SyncHealthTracker(createStore() as never, () => now);
    const day = 24 * 60 * 60 * 1000;

    expect(tracker.claimStuckNotice("phone", day)).toBe(true);
    now = 30 * 60 * 1000;
    expect(tracker.claimStuckNotice("phone", day)).toBe(false);
    expect(tracker.claimStuckNotice("tablet", day)).toBe(true);
    now = day + 1;
    expect(tracker.claimStuckNotice("phone", day)).toBe(true);
  });

  it("ignores junk on disk instead of failing to start", () => {
    const tracker = new SyncHealthTracker(
      createStore({ lastSyncOkAt: "yesterday", problems: { bogus: 1, conflict: { count: "x" } } }) as never,
    );
    tracker.load();

    expect(tracker.snapshot()).toEqual({
      activeSince: null,
      lastSyncOkAt: null,
      lastErrorAt: null,
      serverCursor: null,
      problems: {},
    });
  });
});

describe("classifying a sync error for the report", () => {
  const online = () => false;

  it("uses the same tests as the notice", () => {
    expect(
      classifySyncError(
        new VaultWriteError("write", "Notes/Why?.md", new Error("FILE_NOTCREATED")),
        online,
      ),
    ).toBe("name_refused");
    expect(
      classifySyncError(new VaultWriteError("write", "Notes/a.md", new Error("EACCES")), online),
    ).toBe("write_failed");
    expect(classifySyncError(new Error("net::ERR_CONNECTION_RESET"), online)).toBe(
      "connection_drop",
    );
    expect(
      classifySyncError(Object.assign(new Error("error code: 1102"), { status: 503 }), online),
    ).toBe("server_unavailable");
    expect(classifySyncError(new Error("hash does not match"), online)).toBe("sync_error");
  });
});

describe("device report encryption", () => {
  const key = new Uint8Array(32).fill(3);
  const phone = { vaultId: "vault-1", localVaultId: "phone" };

  it("round-trips for the device it was written for", async () => {
    const envelope = await encryptDeviceReportDetails(key, new TextEncoder().encode("details"), phone);
    const plaintext = await decryptDeviceReportDetails(key, envelope, phone);

    expect(new TextDecoder().decode(plaintext)).toBe("details");
  });

  it("will not decrypt when filed under another device", async () => {
    // A server that moved the phone's details into the laptop's row would be
    // showing the laptop's owner a story about the wrong device.
    const envelope = await encryptDeviceReportDetails(key, new TextEncoder().encode("details"), phone);

    await expect(
      decryptDeviceReportDetails(key, envelope, { vaultId: "vault-1", localVaultId: "laptop" }),
    ).rejects.toThrow("Could not decrypt device report for device laptop");
  });

  it("will not decrypt without the vault key", async () => {
    const envelope = await encryptDeviceReportDetails(key, new TextEncoder().encode("details"), phone);

    await expect(
      decryptDeviceReportDetails(new Uint8Array(32).fill(4), envelope, phone),
    ).rejects.toThrow();
  });
});
