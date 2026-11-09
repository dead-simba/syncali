/**
 * What a device report means, in words. Pure and dependency-free on purpose:
 * the plugin's Devices view and `pnpm sync:doctor` (which runs this file under
 * Node directly) must reach the same verdict from the same report, so there is
 * one copy of the rules. Keep it to erasable TypeScript - no enums, no
 * parameter properties - and import nothing.
 */

export type DevicePlatform = "android" | "ios" | "macos" | "windows" | "linux" | "unknown";

export interface ProblemCount {
  count: number;
  firstAt: number;
  lastAt: number;
}

/** The readable half of a device report: counters only, never names. */
export interface DeviceReport {
  schema: 1;
  generatedAt: number;
  platform: DevicePlatform;
  mobile: boolean;
  pluginVersion: string;
  obsidianVersion: string;
  status: string;
  cursor: number;
  serverCursor: number | null;
  /** When this device began trying to sync continuously (start or resume). */
  activeSince: number | null;
  lastSyncOkAt: number | null;
  lastErrorAt: number | null;
  pendingUploads: number;
  setAside: number;
  skippedUnreadable: number;
  problems: Record<string, ProblemCount>;
  files: { count: number; digest: string } | null;
  rules: {
    images: boolean;
    audio: boolean;
    videos: boolean;
    pdf: boolean;
    other: boolean;
    excludedFolders: number;
  };
}

export type DeviceVerdictState =
  | "up_to_date"
  | "catching_up"
  | "needs_attention"
  | "stuck"
  | "quiet";

export interface DeviceVerdict {
  state: DeviceVerdictState;
  headline: string;
  reasons: string[];
}

/** No report for this long reads as switched off or asleep, not broken. */
export const QUIET_AFTER_MS = 24 * 60 * 60 * 1000;
/** Trying to sync for this long without finishing once is stuck. */
export const STUCK_AFTER_MS = 60 * 60 * 1000;
/** A report older than this cannot vouch for the device being alive now. */
export const ALIVE_WITHIN_MS = 2 * 60 * 60 * 1000;

const PROBLEM_WORDS: Record<string, string> = {
  connection_drop: "Lost the connection",
  server_unavailable: "The server could not handle a request",
  name_refused: "Could not create a file whose name this device does not allow",
  write_failed: "Could not write a file to this device",
  sync_error: "A sync failed",
  conflict: "Kept both versions of a file edited in two places",
  set_aside: "Set a file aside so the rest could sync",
  unreadable_entry: "Skipped an item that would not decrypt on this device",
  stale_recovered: "Recovered an edit the server rejected as out of date",
};

/**
 * Judge one device from its latest report.
 *
 * @param latestServerCursor the newest server position known from anywhere -
 *   another device's report, or the server's own status - so a device that
 *   stopped hearing about changes is still seen to be behind.
 */
export function assessDevice(input: {
  report: DeviceReport;
  reportedAt: number;
  now: number;
  latestServerCursor?: number | null;
}): DeviceVerdict {
  const { report, reportedAt, now } = input;
  const serverCursor = Math.max(report.serverCursor ?? 0, input.latestServerCursor ?? 0);
  const behind = Math.max(0, serverCursor - report.cursor);
  const lastOk = report.lastSyncOkAt;
  const reasons = describeReasons(report, behind);

  if (now - reportedAt > QUIET_AFTER_MS) {
    return {
      state: "quiet",
      headline: `Not heard from in ${formatDuration(now - reportedAt)}`,
      reasons: reasons.length > 0 ? reasons.map((reason) => `At its last report: ${reason}`) : [],
    };
  }

  const problemsSinceOk = Object.values(report.problems).some(
    (problem) => problem.lastAt > (lastOk ?? 0),
  );
  const tryingSince = Math.max(lastOk ?? 0, report.activeSince ?? 0);
  const alive = now - reportedAt <= ALIVE_WITHIN_MS;
  const notFinishing = tryingSince === 0 || reportedAt - tryingSince > STUCK_AFTER_MS;
  if (
    alive &&
    notFinishing &&
    (behind > 0 || report.status === "attention_needed" || problemsSinceOk)
  ) {
    return {
      state: "stuck",
      headline:
        lastOk === null
          ? "Has not finished a sync"
          : `Has not finished a sync since ${formatDate(lastOk)}`,
      reasons,
    };
  }

  if (behind > 0) {
    return {
      state: "catching_up",
      headline: `Catching up: ${formatCount(behind, "change")} behind`,
      reasons,
    };
  }

  const notSyncing = report.setAside + report.skippedUnreadable;
  if (notSyncing > 0) {
    return {
      state: "needs_attention",
      headline: `${formatCount(notSyncing, "file")} not syncing`,
      reasons,
    };
  }

  return {
    state: "up_to_date",
    headline:
      lastOk === null
        ? "Up to date"
        : `Up to date, last synced ${formatDuration(Math.max(0, now - lastOk))} ago`,
    reasons,
  };
}

function describeReasons(report: DeviceReport, behind: number): string[] {
  const reasons: string[] = [];
  if (behind > 0) {
    reasons.push(`${formatCount(behind, "change")} on the server it has not received`);
  }
  if (report.pendingUploads > 0) {
    reasons.push(`${formatCount(report.pendingUploads, "change")} waiting to upload`);
  }
  if (report.setAside > 0) {
    reasons.push(`${formatCount(report.setAside, "file")} set aside, listed under Files not syncing`);
  }
  if (report.skippedUnreadable > 0) {
    reasons.push(`${formatCount(report.skippedUnreadable, "item")} on the server would not decrypt here`);
  }

  const since = report.lastSyncOkAt ?? 0;
  const recent = Object.entries(report.problems)
    .filter(([, problem]) => problem.lastAt > since)
    .sort((a, b) => b[1].lastAt - a[1].lastAt);
  for (const [kind, problem] of recent) {
    const what = PROBLEM_WORDS[kind] ?? kind;
    reasons.push(
      problem.count > 1
        ? `${what}: ${formatCount(problem.count, "time")} since ${formatDate(problem.firstAt)}, last ${formatDate(problem.lastAt)}`
        : `${what}: ${formatDate(problem.lastAt)}`,
    );
  }
  return reasons;
}

/**
 * Notes on devices that should hold the same files but do not. Only devices
 * that are up to date and sync the same file types are compared: one that
 * leaves videos out is expected to differ.
 */
export function compareDeviceFiles(
  devices: Array<{ label: string; report: DeviceReport; verdict: DeviceVerdict }>,
): string[] {
  const comparable = devices.filter(
    (device) => device.verdict.state === "up_to_date" && device.report.files !== null,
  );
  const notes: string[] = [];
  for (let i = 0; i < comparable.length; i += 1) {
    for (let j = i + 1; j < comparable.length; j += 1) {
      const a = comparable[i];
      const b = comparable[j];
      if (!a || !b || !a.report.files || !b.report.files) {
        continue;
      }
      if (JSON.stringify(a.report.rules) !== JSON.stringify(b.report.rules)) {
        continue;
      }
      if (a.report.files.digest !== b.report.files.digest) {
        notes.push(
          `${a.label} holds ${formatCount(a.report.files.count, "file")} and ${b.label} holds ` +
            `${formatCount(b.report.files.count, "file")}, and their contents differ, though both say they are up to date.`,
        );
      }
    }
  }
  return notes;
}

export function describePlatform(platform: DevicePlatform, mobile: boolean): string {
  switch (platform) {
    case "android":
      return mobile ? "Android phone" : "Android device";
    case "ios":
      return "iPhone or iPad";
    case "macos":
      return "Mac";
    case "windows":
      return "Windows PC";
    case "linux":
      return "Linux computer";
    default:
      return "Device";
  }
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) {
    return "less than a minute";
  }
  if (minutes < 60) {
    return formatCount(minutes, "minute");
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return formatCount(hours, "hour");
  }
  return formatCount(Math.round(hours / 24), "day");
}

export function formatDate(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatCount(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}
