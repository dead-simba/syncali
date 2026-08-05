import { t } from "../../i18n";

export type UserVisibleSyncState =
  | "not_ready"
  | "paused"
  | "syncing"
  | "offline"
  | "reconnecting"
  | "up_to_date"
  | "attention_needed";

export interface UserVisibleSyncProgress {
  completedEntries: number;
  totalEntries: number;
}

export function getUserVisibleSyncPercent(
  progress: UserVisibleSyncProgress | null,
): number | null {
  if (!progress || progress.totalEntries <= 0) {
    return null;
  }

  return Math.floor((progress.completedEntries / progress.totalEntries) * 100);
}

/**
 * States that describe a finished condition rather than work in progress.
 *
 * Progress counts are only refreshed while a sync is running, so once it stops
 * the last numbers linger. Reporting them against a finished state produced
 * "up to date 99% - 1472 / 1474", which reads as the app disagreeing with
 * itself - and after a real sync failure, an app that contradicts itself is
 * indistinguishable from one that is broken.
 */
const SETTLED_STATES: ReadonlySet<UserVisibleSyncState> = new Set([
  "up_to_date",
  "paused",
  "not_ready",
]);

export function isSettledSyncState(state: UserVisibleSyncState): boolean {
  return SETTLED_STATES.has(state);
}

export function getUserVisibleSyncDisplayPercent(
  state: UserVisibleSyncState,
  progress: UserVisibleSyncProgress | null = null,
): number {
  // A settled state is the authority on itself. Stale counts from the last run
  // do not get to contradict it.
  if (state === "up_to_date") {
    return 100;
  }
  if (isSettledSyncState(state)) {
    return 0;
  }

  return getUserVisibleSyncPercent(progress) ?? 0;
}

export function formatUserVisibleSyncState(
  state: UserVisibleSyncState,
  progress: UserVisibleSyncProgress | null = null,
): string {
  // Nothing is in flight, so a percentage is noise at best and a
  // contradiction at worst. Say the state and stop talking.
  if (isSettledSyncState(state)) {
    return t(`sync.state.${state}`);
  }

  return t("sync.status", {
    label: t(`sync.state.${state}`),
    percent: getUserVisibleSyncDisplayPercent(state, progress),
  });
}
