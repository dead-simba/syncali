import type { PluginDataStoreLike } from "../../plugin-data";
import type { ProblemCount } from "./device-verdict";
import { PROBLEM_KINDS, type ProblemKind } from "./problem-kind";

const STORE_KEY = "syncHealth";

export interface SyncHealthSnapshot {
  activeSince: number | null;
  lastSyncOkAt: number | null;
  lastErrorAt: number | null;
  serverCursor: number | null;
  problems: Partial<Record<ProblemKind, ProblemCount>>;
}

interface StoredHealth extends SyncHealthSnapshot {
  stuckNoticeAt: Record<string, number>;
}

/**
 * What this device knows about how its syncing is going, kept across restarts.
 *
 * Fed by the sync engine as things happen and read by the device report. A
 * sync that never finishes leaves `lastSyncOkAt` behind while problems keep
 * counting, which is the shape a stuck device has.
 */
export class SyncHealthTracker {
  private state: StoredHealth = emptyState();

  constructor(
    private readonly store: PluginDataStoreLike,
    private readonly now: () => number = () => Date.now(),
  ) {}

  load(): void {
    this.state = parseStored(this.store.read<unknown>(STORE_KEY));
  }

  snapshot(): SyncHealthSnapshot {
    return {
      activeSince: this.state.activeSince,
      lastSyncOkAt: this.state.lastSyncOkAt,
      lastErrorAt: this.state.lastErrorAt,
      serverCursor: this.state.serverCursor,
      problems: Object.fromEntries(
        Object.entries(this.state.problems).map(([kind, count]) => [kind, { ...count }]),
      ),
    };
  }

  /** Auto sync started or resumed: the clock for "has not finished" starts here. */
  markActive(): void {
    this.state.activeSince = this.now();
  }

  /** A sync pass finished with nothing left to do. */
  recordSyncOk(): void {
    this.state.lastSyncOkAt = this.now();
  }

  recordServerCursor(cursor: number): void {
    if (Number.isSafeInteger(cursor) && cursor >= 0) {
      this.state.serverCursor = Math.max(this.state.serverCursor ?? 0, cursor);
    }
  }

  recordProblem(kind: ProblemKind): void {
    const at = this.now();
    const existing = this.state.problems[kind];
    this.state.problems[kind] = existing
      ? { count: existing.count + 1, firstAt: existing.firstAt, lastAt: at }
      : { count: 1, firstAt: at, lastAt: at };
    if (kind !== "conflict") {
      this.state.lastErrorAt = at;
    }
  }

  /**
   * Whether to warn about another device being stuck now, at most once per
   * `withinMs` for each device - a warning repeated every half hour is noise.
   */
  claimStuckNotice(localVaultId: string, withinMs: number): boolean {
    const at = this.now();
    const last = this.state.stuckNoticeAt[localVaultId];
    if (last !== undefined && at - last < withinMs) {
      return false;
    }
    this.state.stuckNoticeAt[localVaultId] = at;
    return true;
  }

  async persist(): Promise<void> {
    this.store.write(STORE_KEY, this.state);
    await this.store.save();
  }
}

function emptyState(): StoredHealth {
  return {
    activeSince: null,
    lastSyncOkAt: null,
    lastErrorAt: null,
    serverCursor: null,
    problems: {},
    stuckNoticeAt: {},
  };
}

function parseStored(value: unknown): StoredHealth {
  const state = emptyState();
  if (!value || typeof value !== "object") {
    return state;
  }
  const stored = value as Partial<Record<keyof StoredHealth, unknown>>;
  state.activeSince = finiteOrNull(stored.activeSince);
  state.lastSyncOkAt = finiteOrNull(stored.lastSyncOkAt);
  state.lastErrorAt = finiteOrNull(stored.lastErrorAt);
  state.serverCursor = finiteOrNull(stored.serverCursor);

  if (stored.problems && typeof stored.problems === "object") {
    for (const kind of PROBLEM_KINDS) {
      const count = (stored.problems as Record<string, unknown>)[kind];
      if (isProblemCount(count)) {
        state.problems[kind] = { ...count };
      }
    }
  }
  if (stored.stuckNoticeAt && typeof stored.stuckNoticeAt === "object") {
    for (const [id, at] of Object.entries(stored.stuckNoticeAt)) {
      if (typeof at === "number" && Number.isFinite(at)) {
        state.stuckNoticeAt[id] = at;
      }
    }
  }
  return state;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isProblemCount(value: unknown): value is ProblemCount {
  if (!value || typeof value !== "object") {
    return false;
  }
  const { count, firstAt, lastAt } = value as Record<string, unknown>;
  return (
    typeof count === "number" &&
    typeof firstAt === "number" &&
    typeof lastAt === "number" &&
    count >= 1
  );
}
