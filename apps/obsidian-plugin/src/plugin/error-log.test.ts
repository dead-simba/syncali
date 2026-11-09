import { describe, expect, it, vi } from "vitest";

import { SyncErrorLog } from "./error-log";

/**
 * What these protect: an error the user saw must still be readable later.
 *
 * The reason this exists at all is the phone - a notice there is unrecoverable
 * once it fades, so a log that drops, floods or loses entries is no better
 * than no log.
 */

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

describe("the log of recent problems", () => {
  it("keeps errors in view newest first", () => {
    const log = new SyncErrorLog(createStore() as never);
    log.record("first", 1_000);
    log.record("second", 2_000);

    expect(log.list().map((entry) => entry.message)).toEqual(["second", "first"]);
  });

  it("survives a restart", async () => {
    // The whole point: an error from this morning is still there tonight.
    const store = createStore();
    const log = new SyncErrorLog(store as never);
    log.record("sync failed", 1_000);
    await log.persist();

    const reopened = new SyncErrorLog(createStore(store.stored) as never);
    reopened.load();

    expect(reopened.list()).toEqual([
      { at: 1_000, message: "sync failed", firstAt: 1_000, count: 1 },
    ]);
  });

  it("collapses a repeat instead of letting it flood the log", () => {
    // A failing sync retries on a timer. Fifty copies of one message would
    // push out the earlier errors that actually explain what started it.
    const log = new SyncErrorLog(createStore() as never);
    log.record("earlier and more useful", 1_000);
    for (let i = 0; i < 60; i += 1) {
      log.record("connection lost", 2_000 + i);
    }

    expect(log.list()).toHaveLength(2);
    expect(log.list()[0]).toEqual({
      at: 2_059,
      message: "connection lost",
      firstAt: 2_000,
      count: 60,
    });
    expect(log.list()[1]?.message).toBe("earlier and more useful");
  });

  it("says how long a repeated problem has been happening, not only when it last did", () => {
    // One line dated today, read as a one-off, was a failure on every pull for
    // two weeks. The text form is what gets pasted into a bug report.
    const log = new SyncErrorLog(createStore() as never);
    log.record("write failed", Date.UTC(2026, 9, 26, 6, 20));
    log.record("write failed", Date.UTC(2026, 10, 9, 7, 14));

    expect(log.toText()).toBe(
      "2026-11-09T07:14:00.000Z  write failed  (2 times since 2026-10-26T06:20:00.000Z)",
    );
  });

  it("reads entries saved before repeats were counted", () => {
    const log = new SyncErrorLog(createStore([{ at: 5_000, message: "old" }]) as never);
    log.load();

    expect(log.list()).toEqual([{ at: 5_000, message: "old", firstAt: 5_000, count: 1 }]);
  });

  it("drops the oldest once it is full, rather than growing forever", () => {
    const log = new SyncErrorLog(createStore() as never);
    for (let i = 0; i < 60; i += 1) {
      log.record(`error ${i}`, 1_000 + i);
    }

    const messages = log.list().map((entry) => entry.message);
    expect(messages).toHaveLength(50);
    expect(messages[0]).toBe("error 59");
    expect(messages).not.toContain("error 9");
  });

  it("ignores junk on disk instead of failing to start", () => {
    const log = new SyncErrorLog(
      createStore([{ at: "not a number", message: "x" }, null, "nope"]) as never,
    );
    log.load();

    expect(log.list()).toEqual([]);
  });

  it("keeps a conflict notice, not only an error", () => {
    // The first thing the log missed: a path collision names a file that needs
    // a decision, and it was shown as an ordinary Notice - so on a phone it
    // was gone in seconds with nothing to go back to.
    const log = new SyncErrorLog(createStore() as never);
    log.record(
      'Sync path collision detected. The remote file was saved to "Notes/A.sync-conflict-20260901-081436.md".',
      1_000,
    );

    expect(log.list()[0]?.message).toContain("sync-conflict-20260901-081436.md");
  });

  it("renders as text that can be pasted into a report", () => {
    const log = new SyncErrorLog(createStore() as never);
    log.record("could not read Islam/Allah.md", Date.UTC(2026, 8, 1, 12, 0, 0));

    expect(log.toText()).toBe("2026-09-01T12:00:00.000Z  could not read Islam/Allah.md");
  });
});
