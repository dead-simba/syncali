import { describe, expect, it, vi } from "vitest";

import {
  createInitializedTestSyncStore,
  createTestPlugin,
} from "../../../../test-support/test-plugin";
import type { SyncRealtimeCallbacks } from "../../../remote/realtime-client";
import { SyncAutoLoop } from "../../auto-sync";
import type { PullOnceResult } from "../../pull-service";
import { createPushResult, createRealtimeClient, createToken } from "./helpers";

/**
 * A pass that changes nothing must not run again straight away.
 *
 * Measured on a desktop: one 13 KB note uploaded 837 times in 12.8 minutes,
 * about one upload every 0.9 seconds. The push was told to pull first, the
 * pull had nothing for that note, and the loop went round again with no delay
 * at all. Whatever the next cause of that shape turns out to be, the loop
 * itself has to slow down once a pass stops making progress.
 */

const STALLED_PUSH = createPushResult({
  mutationsPushed: 0,
  mutationsRequeued: 1,
  filesCreatedOrUpdated: 0,
  shouldPullAfterPush: true,
  hasMore: true,
});

function pullResult(entriesApplied: number): PullOnceResult {
  return {
    cursor: 1,
    entriesApplied,
    filesWritten: entriesApplied,
    filesDeleted: 0,
    conflictsCreated: 0,
  };
}

// Without the backoff the loop never yields to the timers, so the test would
// hang rather than fail. Past this many passes the fake push reports the queue
// empty, which lets it finish and fail on the count instead.
const RUNAWAY_LIMIT = 50;

async function startLoop(
  pushPendingMutations: () => Promise<ReturnType<typeof createPushResult>>,
  pullOnce: () => Promise<PullOnceResult>,
  onError?: (error: unknown) => void,
) {
  const store = await createInitializedTestSyncStore(createTestPlugin());
  let callbacks: SyncRealtimeCallbacks | null = null;
  const autoLoop = new SyncAutoLoop({
    getApiBaseUrl: () => "http://127.0.0.1:8787",
    getSyncToken: async () => createToken(),
    getSyncStore: () => store,
    pushPendingMutations,
    pullOnce,
    onError,
    realtimeClient: createRealtimeClient((opened) => {
      callbacks = opened;
    }),
    pushDebounceMs: 0,
    syncRetryBaseDelayMs: 1_000,
    syncRetryMaxDelayMs: 30_000,
  });
  await autoLoop.start();
  return {
    store,
    autoLoop,
    advanceCursor: (cursor: number) => callbacks?.onCursorAdvanced?.(cursor),
  };
}

describe("a sync pass that makes no progress", () => {
  it("waits on the retry backoff instead of looping immediately", async () => {
    vi.useFakeTimers();
    let passes = 0;
    const pushPendingMutations = vi.fn(async () => {
      passes += 1;
      return passes > RUNAWAY_LIMIT ? createPushResult({ mutationsPushed: 0 }) : STALLED_PUSH;
    });
    const pullOnce = vi.fn(async () => pullResult(0));
    const { store, autoLoop } = await startLoop(pushPendingMutations, pullOnce);

    autoLoop.notifyLocalChange();
    await vi.advanceTimersByTimeAsync(60_000);

    // 0s, then 1, 2, 4, 8, 16 and 30 seconds apart: seven passes in a minute,
    // where the loop without a backoff managed one every 0.9 seconds.
    expect(pushPendingMutations.mock.calls.length).toBeLessThanOrEqual(8);
    expect(pushPendingMutations.mock.calls.length).toBeGreaterThanOrEqual(5);

    autoLoop.stop();
    await store.close();
    vi.useRealTimers();
  });

  it("goes back to full speed as soon as a pass makes progress", async () => {
    vi.useFakeTimers();
    const passTimes: number[] = [];
    // Two stalled passes, one where the pull brings something down, then
    // stalled again. The delay after the productive pass must start over.
    const pulls = [0, 0, 1, 0, 0];
    const pushPendingMutations = vi.fn(async () => {
      passTimes.push(Date.now());
      return passTimes.length > pulls.length ? createPushResult() : STALLED_PUSH;
    });
    const pullOnce = vi.fn(async () => pullResult(pulls[passTimes.length - 1] ?? 0));
    const { store, autoLoop } = await startLoop(pushPendingMutations, pullOnce);

    autoLoop.notifyLocalChange();
    await vi.advanceTimersByTimeAsync(20_000);

    const gaps = passTimes.slice(1).map((time, index) => time - passTimes[index]);
    // Stalled, stalled: 1s then 2s. The third pass made progress, so the
    // fourth runs at once, and the stall after it waits the base delay again.
    expect(gaps.slice(0, 4)).toEqual([1_000, 2_000, 0, 1_000]);

    autoLoop.stop();
    await store.close();
    vi.useRealTimers();
  });

  it("does not back off a pass whose push landed something", async () => {
    vi.useFakeTimers();
    let passes = 0;
    const pushPendingMutations = vi.fn(async () => {
      passes += 1;
      return createPushResult({
        mutationsPushed: 1,
        mutationsRequeued: 1,
        shouldPullAfterPush: true,
        hasMore: passes < 3,
      });
    });
    const pullOnce = vi.fn(async () => pullResult(0));
    const { store, autoLoop } = await startLoop(pushPendingMutations, pullOnce);

    autoLoop.notifyLocalChange();
    await vi.advanceTimersByTimeAsync(0);

    expect(pushPendingMutations).toHaveBeenCalledTimes(3);

    autoLoop.stop();
    await store.close();
    vi.useRealTimers();
  });

  it("keeps the push waiting while other devices' changes arrive", async () => {
    // A pull that another device's write triggers is not a reason to retry a
    // push that is waiting out its backoff. Letting it through ran the stalled
    // push once a second whenever another device was busy: 65 passes in a
    // minute, where the backoff alone allows 7.
    vi.useFakeTimers();
    let passes = 0;
    const pushPendingMutations = vi.fn(async () => {
      passes += 1;
      return passes > RUNAWAY_LIMIT ? createPushResult({ mutationsPushed: 0 }) : STALLED_PUSH;
    });
    const pullOnce = vi.fn(async () => pullResult(0));
    const { store, autoLoop, advanceCursor } = await startLoop(pushPendingMutations, pullOnce);

    autoLoop.notifyLocalChange();
    for (let second = 1; second <= 60; second += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      advanceCursor(second);
    }

    expect(pushPendingMutations.mock.calls.length).toBeLessThanOrEqual(8);
    // The pulls themselves still ran: the push is held, not the vault.
    expect(pullOnce.mock.calls.length).toBeGreaterThan(pushPendingMutations.mock.calls.length);

    autoLoop.stop();
    await store.close();
    vi.useRealTimers();
  });

  it("backs off and reports it when one file's upload has to be retried", async () => {
    // The rest of the batch went through, so this is progress by the other
    // measures - but the file left behind would be uploaded again at once.
    vi.useFakeTimers();
    const failure = new Error("Blob upload failed: unexpected server error (http_500)");
    let passes = 0;
    const pushPendingMutations = vi.fn(async () => {
      passes += 1;
      return passes > RUNAWAY_LIMIT
        ? createPushResult()
        : createPushResult({
            mutationsPushed: 1,
            mutationsRequeued: 1,
            hasMore: true,
            retryLater: { error: failure },
          });
    });
    const onError = vi.fn();
    const { store, autoLoop } = await startLoop(
      pushPendingMutations,
      async () => pullResult(0),
      onError,
    );

    autoLoop.notifyLocalChange();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(pushPendingMutations.mock.calls.length).toBeLessThanOrEqual(8);
    expect(onError).toHaveBeenCalledWith(failure);
    expect(onError).toHaveBeenCalledTimes(pushPendingMutations.mock.calls.length);

    autoLoop.stop();
    await store.close();
    vi.useRealTimers();
  });
});

describe("a backoff that a failing pull started", () => {
  function failingPulls(failures: number) {
    let pulls = 0;
    return vi.fn(async () => {
      pulls += 1;
      if (pulls <= failures) {
        throw new Error("Blob download failed: unexpected server error (http_500)");
      }
      return pullResult(0);
    });
  }

  it("does not hold back a local edit", async () => {
    // Only a push that failed or went nowhere earns a held push. Holding one
    // behind a pull's backoff kept a healthy edit waiting for the old timer,
    // up to 30 seconds, after the pull had already recovered.
    vi.useFakeTimers();
    const pushTimes: number[] = [];
    const pushPendingMutations = vi.fn(async () => {
      pushTimes.push(Date.now());
      return createPushResult();
    });
    const { store, autoLoop, advanceCursor } = await startLoop(
      pushPendingMutations,
      failingPulls(5),
    );
    const startedAt = Date.now();

    // Pulls fail at 0, 1, 3, 7 and 15 seconds; the next try is due at 31.
    advanceCursor(1);
    await vi.advanceTimersByTimeAsync(16_000);
    const editAt = Date.now();
    autoLoop.notifyLocalChange();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(editAt - startedAt).toBe(16_000);
    expect(pushTimes).toEqual([editAt]);

    autoLoop.stop();
    await store.close();
    vi.useRealTimers();
  });
});

describe("a push waiting out a backoff when sync stops and starts again", () => {
  it("is pushed on the next session instead of reported as up to date", async () => {
    // stop() empties the in-memory queue. The store still holds the change,
    // so the new session has to ask it rather than report idle over an edit
    // that never left this device.
    vi.useFakeTimers();
    const store = await createInitializedTestSyncStore(createTestPlugin());
    let pendingInStore = false;
    let failedPushes = 0;
    const pushPendingMutations = vi.fn(async () => {
      if (failedPushes < 2) {
        failedPushes += 1;
        return STALLED_PUSH;
      }
      pendingInStore = false;
      return createPushResult();
    });
    const idle = vi.fn();
    const autoLoop = new SyncAutoLoop({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      hasPendingMutations: async () => pendingInStore,
      pushPendingMutations,
      pullOnce: async () => pullResult(0),
      onIdle: idle,
      realtimeClient: createRealtimeClient(),
      pushDebounceMs: 0,
      syncRetryBaseDelayMs: 10_000,
      syncRetryMaxDelayMs: 30_000,
    });
    await autoLoop.start();

    pendingInStore = true;
    autoLoop.notifyLocalChange();
    await vi.advanceTimersByTimeAsync(0);
    expect(pushPendingMutations).toHaveBeenCalledTimes(1);
    // A second edit, held behind the stalled push's backoff.
    autoLoop.notifyLocalChange();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pushPendingMutations).toHaveBeenCalledTimes(1);

    autoLoop.stop();
    idle.mockClear();
    await autoLoop.start();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(pushPendingMutations.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(pendingInStore).toBe(false);

    autoLoop.stop();
    await store.close();
    vi.useRealTimers();
  });
});
