import type { SyncFileRules } from "../core/file-rules";
import type { SyncReconcileEntryState } from "../store/store";
import type { SyncHealthSnapshot } from "./health-tracker";
import type { DevicePlatform, DeviceReport } from "./device-verdict";

export const MAX_REPORTED_PROBLEMS = 20;
export const MAX_REPORTED_SET_ASIDE = 100;
export const MAX_REPORTED_NOT_YET_SYNCED = 50;

export interface FolderFingerprint {
  /** Top-level folder, or "/" for files at the root of the vault. */
  folder: string;
  files: number;
  digest: string;
}

export type NotYetSyncedState = "waiting_to_upload" | "not_downloaded" | "differs";

/**
 * The private half of a device report. Encrypted with the vault key before it
 * leaves the device; it names files and quotes errors, so the server must
 * never see it.
 */
export interface DeviceReportDetails {
  version: 1;
  deviceLabel: string;
  vaultName: string;
  recentProblems: Array<{ at: number; firstAt: number; count: number; message: string }>;
  setAside: Array<{ path: string; op: "upsert" | "delete"; reason: string }>;
  notYetSynced: Array<{ path: string; state: NotYetSyncedState }>;
  notYetSyncedTotal: number;
  folders: FolderFingerprint[];
}

export interface DeviceReportInput {
  now: number;
  platform: DevicePlatform;
  mobile: boolean;
  pluginVersion: string;
  obsidianVersion: string;
  status: string;
  cursor: number;
  health: SyncHealthSnapshot;
  entries: SyncReconcileEntryState[];
  setAsideFiles: Array<{ path: string; op?: "upsert" | "delete"; reason?: string }>;
  skippedUnreadable: number;
  rules: SyncFileRules;
  recentProblems: readonly { at: number; message: string; firstAt?: number; count?: number }[];
  deviceLabel: string;
  vaultName: string;
  /** Keyed digest; see `computeVaultKeyedDigest`. */
  digest: (data: Uint8Array) => Promise<string>;
  /** Whether this device's rules keep a server path here at all. */
  isSyncedHere?: (path: string) => boolean;
}

export async function buildDeviceReport(
  input: DeviceReportInput,
): Promise<{ report: DeviceReport; details: DeviceReportDetails }> {
  const heldFiles = input.entries.flatMap((entry) =>
    entry.local && !entry.local.deleted && entry.local.path && entry.local.hash
      ? [{ path: entry.local.path, hash: entry.local.hash }]
      : [],
  );
  const fingerprint = await fingerprintFiles(heldFiles, input.digest);
  const notYetSynced = listNotYetSynced(input.entries, input.isSyncedHere);
  const pendingUploads = input.entries.filter(
    (entry) => entry.dirty && entry.dirty.status !== "blocked",
  ).length;

  const report: DeviceReport = {
    schema: 1,
    generatedAt: input.now,
    platform: input.platform,
    mobile: input.mobile,
    pluginVersion: sanitizeVersion(input.pluginVersion),
    obsidianVersion: sanitizeVersion(input.obsidianVersion),
    status: /^[a-z_]{0,32}$/.test(input.status) ? input.status : "",
    cursor: input.cursor,
    serverCursor: input.health.serverCursor,
    activeSince: input.health.activeSince,
    lastSyncOkAt: input.health.lastSyncOkAt,
    lastErrorAt: input.health.lastErrorAt,
    pendingUploads,
    setAside: input.setAsideFiles.length,
    skippedUnreadable: input.skippedUnreadable,
    problems: { ...input.health.problems },
    files: { count: fingerprint.count, digest: fingerprint.digest },
    rules: {
      images: input.rules.includeImages,
      audio: input.rules.includeAudio,
      videos: input.rules.includeVideos,
      pdf: input.rules.includePdf,
      other: input.rules.includeOtherFiles,
      excludedFolders: input.rules.excludedFolders.length,
    },
  };

  const details: DeviceReportDetails = {
    version: 1,
    deviceLabel: input.deviceLabel,
    vaultName: input.vaultName,
    recentProblems: input.recentProblems.slice(0, MAX_REPORTED_PROBLEMS).map((problem) => ({
      at: problem.at,
      firstAt: problem.firstAt ?? problem.at,
      count: problem.count ?? 1,
      message: problem.message,
    })),
    setAside: input.setAsideFiles.slice(0, MAX_REPORTED_SET_ASIDE).map((file) => ({
      path: file.path,
      op: file.op ?? "upsert",
      reason: file.reason ?? "file_too_large",
    })),
    notYetSynced: notYetSynced.slice(0, MAX_REPORTED_NOT_YET_SYNCED),
    notYetSyncedTotal: notYetSynced.length,
    folders: fingerprint.folders,
  };

  return { report, details };
}

/**
 * A fingerprint of the files a device holds: path and content hash of each,
 * in a fixed order, through a keyed digest. Two devices holding the same files
 * get the same value. Per top-level folder too, so a mismatch can be narrowed
 * down without sending every file name.
 */
export async function fingerprintFiles(
  files: Array<{ path: string; hash: string }>,
  digest: (data: Uint8Array) => Promise<string>,
): Promise<{ count: number; digest: string; folders: FolderFingerprint[] }> {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const encoder = new TextEncoder();
  const line = (file: { path: string; hash: string }) => `${file.path}\u0000${file.hash}\n`;

  const byFolder = new Map<string, string[]>();
  for (const file of sorted) {
    const slash = file.path.indexOf("/");
    const folder = slash === -1 ? "/" : file.path.slice(0, slash);
    const lines = byFolder.get(folder) ?? [];
    lines.push(line(file));
    byFolder.set(folder, lines);
  }

  const folders: FolderFingerprint[] = [];
  for (const [folder, lines] of [...byFolder.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  )) {
    folders.push({
      folder,
      files: lines.length,
      digest: await digest(encoder.encode(lines.join(""))),
    });
  }

  return {
    count: sorted.length,
    digest: await digest(encoder.encode(sorted.map(line).join(""))),
    folders,
  };
}

/**
 * Files this device knows are not the same here as on the server: a change
 * still waiting to go up, a server file not written here, or a local copy
 * whose content differs from the server's. A device that is behind does not
 * know what it has not been told about; its cursor says that instead.
 */
export function listNotYetSynced(
  entries: SyncReconcileEntryState[],
  isSyncedHere: (path: string) => boolean = () => true,
): Array<{ path: string; state: NotYetSyncedState }> {
  const result: Array<{ path: string; state: NotYetSyncedState }> = [];
  for (const entry of entries) {
    const { local, remote, dirty } = entry;
    const path = local?.path ?? remote?.path ?? null;
    if (!path) {
      continue;
    }
    if (dirty && dirty.status !== "blocked") {
      result.push({ path, state: "waiting_to_upload" });
      continue;
    }
    if (dirty) {
      // Blocked changes are listed under setAside with their reason.
      continue;
    }
    const remoteLive = remote && !remote.deleted && remote.revision > 0;
    const localLive = local && !local.deleted;
    if (!isSyncedHere(path)) {
      // Left out on purpose by this device's file rules, not missing.
      continue;
    }
    if (remoteLive && !localLive) {
      result.push({ path, state: "not_downloaded" });
    } else if (remoteLive && localLive && local.hash && remote.hash && local.hash !== remote.hash) {
      result.push({ path, state: "differs" });
    }
  }
  return result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function sanitizeVersion(value: string): string {
  return /^[0-9A-Za-z.+-]{0,32}$/.test(value) ? value : "";
}
