import { apiVersion, Platform, type Plugin } from "obsidian";

import {
  computeVaultKeyedDigest,
  decryptDeviceReportDetails,
  encryptDeviceReportDetails,
} from "../core/crypto";
import type { SyncFileRules } from "../core/file-rules";
import type { SyncTokenResponse } from "../remote/client";
import {
  SYNC_FEATURE_DEVICE_REPORTS,
  type SyncRealtimeSession,
} from "../remote/realtime-types";
import type { SyncAuthorizedRequestInput, SyncAuthorizedRequestResult } from "../remote/request-client";
import type { SyncStore } from "../store/store";
import { buildDeviceReport, type DeviceReportDetails } from "./device-report";
import {
  assessDevice,
  compareDeviceFiles,
  describePlatform,
  type DevicePlatform,
  type DeviceReport,
  type DeviceVerdict,
} from "./device-verdict";
import type { SyncHealthTracker } from "./health-tracker";

export const REPORT_INTERVAL_MS = 10 * 60_000;
export const FIRST_REPORT_DELAY_MS = 60_000;
export const STUCK_CHECK_INTERVAL_MS = 30 * 60_000;
export const STUCK_NOTICE_EVERY_MS = 24 * 60 * 60_000;
/**
 * An unchanged report is sent again after this long, not every ten minutes:
 * about 10 KB each on a phone's data plan. Well inside ALIVE_WITHIN_MS, so a
 * quiet device is never mistaken for a dead one.
 */
export const RESEND_UNCHANGED_AFTER_MS = 60 * 60_000;

/** What the plugin supplies so the engine can report on itself. */
export interface SyncHealthDeps {
  tracker: SyncHealthTracker;
  listRecentProblems: () => readonly {
    at: number;
    message: string;
    firstAt?: number;
    count?: number;
  }[];
  getSyncStatus: () => string;
  /** Tell the user another of their devices is stuck. */
  notifyStuckDevice?: (message: string) => void;
  /** Keep the decrypted reports on this device, where they can be read. */
  writeLocalReports?: (contents: string) => Promise<void>;
}

export interface DeviceReporterTimers {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

export interface DeviceReporterDeps {
  plugin: Plugin;
  health: SyncHealthDeps;
  getStore: () => SyncStore | null;
  getRemoteVaultKey: () => Uint8Array;
  getSyncFileRules: () => SyncFileRules;
  isSyncedHere: (path: string) => boolean;
  getLiveSession: () => SyncRealtimeSession | null;
  /** Names the vault and device the server files a report under. */
  getSyncToken: () => Promise<SyncTokenResponse>;
  requestClient: {
    request(input: SyncAuthorizedRequestInput): Promise<SyncAuthorizedRequestResult>;
  };
  listSetAsideFiles: () => Promise<Array<{ path: string; op?: "upsert" | "delete"; reason?: string }>>;
  countSkippedUnreadable: () => number;
  now?: () => number;
  timers?: DeviceReporterTimers;
}

export interface DeviceReportView {
  localVaultId: string;
  isThisDevice: boolean;
  label: string;
  reportedAt: number;
  report: DeviceReport | null;
  details: DeviceReportDetails | null;
  /** Why the private half could not be read, if it could not. */
  detailsError: string | null;
  verdict: DeviceVerdict | null;
}

export interface DeviceReportsSnapshot {
  fetchedAt: number;
  latestServerCursor: number | null;
  devices: DeviceReportView[];
  notes: string[];
}

/**
 * Sends this device's health report and reads everyone else's.
 *
 * Runs only while auto sync does, and only against a server that announced
 * `device_reports`, so an older server is never sent a request it does not
 * understand. A report that fails to send is not an error worth a notice:
 * the next one is ten minutes away.
 */
export class DeviceReporter {
  private readonly now: () => number;
  private readonly timers: DeviceReporterTimers;
  private firstReport: unknown = null;
  private reportInterval: unknown = null;
  private stuckInterval: unknown = null;
  private inFlight: Promise<boolean> | null = null;
  private lastSent: { signature: string; at: number } | null = null;

  constructor(private readonly deps: DeviceReporterDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.timers = deps.timers ?? {
      setTimeout: (callback, ms) => window.setTimeout(callback, ms),
      clearTimeout: (handle) => window.clearTimeout(handle as number),
      setInterval: (callback, ms) => window.setInterval(callback, ms),
      clearInterval: (handle) => window.clearInterval(handle as number),
    };
  }

  start(): void {
    this.stop();
    this.firstReport = this.timers.setTimeout(() => {
      this.firstReport = null;
      void this.reportNow();
      void this.checkForStuckDevices();
    }, FIRST_REPORT_DELAY_MS);
    this.reportInterval = this.timers.setInterval(() => {
      void this.reportNow();
    }, REPORT_INTERVAL_MS);
    this.stuckInterval = this.timers.setInterval(() => {
      void this.checkForStuckDevices();
    }, STUCK_CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.firstReport !== null) {
      this.timers.clearTimeout(this.firstReport);
      this.firstReport = null;
    }
    if (this.reportInterval !== null) {
      this.timers.clearInterval(this.reportInterval);
      this.reportInterval = null;
    }
    if (this.stuckInterval !== null) {
      this.timers.clearInterval(this.stuckInterval);
      this.stuckInterval = null;
    }
  }

  /**
   * Send a report now. Resolves false when there was nothing to send it to.
   * Skips one identical to the last unless `force` or an hour has passed.
   */
  async reportNow(options: { force?: boolean } = {}): Promise<boolean> {
    if (this.inFlight) {
      return await this.inFlight;
    }
    this.inFlight = this.sendReport(options.force ?? false).finally(() => {
      this.inFlight = null;
    });
    return await this.inFlight;
  }

  /** Every device's latest report, decrypted and judged. Null if unsupported. */
  async fetchReports(): Promise<DeviceReportsSnapshot | null> {
    if (!this.serverSupportsReports()) {
      return null;
    }
    // A fresh report first, so this device's own line is current.
    await this.reportNow({ force: true });

    const { response, token } = await this.deps.requestClient.request({
      path: (token) => `/v1/vaults/${encodeURIComponent(token.vaultId)}/device-reports`,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Could not read device reports (status ${response.status}).`);
    }

    const rows = readReportRows(response.json);
    const now = this.now();
    const ownServerCursor = this.deps.health.tracker.snapshot().serverCursor;
    const latestServerCursor = Math.max(
      ownServerCursor ?? 0,
      ...rows.map((row) => row.report?.serverCursor ?? 0),
    );

    const devices: DeviceReportView[] = [];
    for (const row of rows) {
      const { details, error } = await this.decryptDetails(token, row.localVaultId, row.details);
      const label = row.report ? describePlatform(row.report.platform, row.report.mobile) : "Device";
      devices.push({
        localVaultId: row.localVaultId,
        isThisDevice: row.isRequestingDevice,
        label,
        reportedAt: row.reportedAt,
        report: row.report,
        details,
        detailsError: error,
        verdict: row.report
          ? assessDevice({
              report: row.report,
              reportedAt: row.reportedAt,
              now,
              latestServerCursor: latestServerCursor || null,
            })
          : null,
      });
    }

    const snapshot: DeviceReportsSnapshot = {
      fetchedAt: now,
      latestServerCursor: latestServerCursor || null,
      devices,
      notes: compareDeviceFiles(
        devices.flatMap((device) =>
          device.report && device.verdict
            ? [{ label: device.label, report: device.report, verdict: device.verdict }]
            : [],
        ),
      ),
    };
    await this.deps.health.writeLocalReports?.(JSON.stringify(snapshot, null, 2));
    return snapshot;
  }

  private async checkForStuckDevices(): Promise<void> {
    let snapshot: DeviceReportsSnapshot | null;
    try {
      snapshot = await this.fetchReports();
    } catch {
      return;
    }
    if (!snapshot) {
      return;
    }

    let claimed = false;
    for (const device of snapshot.devices) {
      if (device.isThisDevice || device.verdict?.state !== "stuck") {
        continue;
      }
      if (!this.deps.health.tracker.claimStuckNotice(device.localVaultId, STUCK_NOTICE_EVERY_MS)) {
        continue;
      }
      claimed = true;
      const headline = device.verdict.headline;
      this.deps.health.notifyStuckDevice?.(
        `Your ${device.label} ${headline.charAt(0).toLowerCase()}${headline.slice(1)}. ` +
          "Open Syncali settings, then Devices, to see why.",
      );
    }
    if (claimed) {
      await this.deps.health.tracker.persist();
    }
  }

  private serverSupportsReports(): boolean {
    return (
      this.deps.getLiveSession()?.features.includes(SYNC_FEATURE_DEVICE_REPORTS) ?? false
    );
  }

  private async sendReport(force: boolean): Promise<boolean> {
    const store = this.deps.getStore();
    if (!store || !this.serverSupportsReports()) {
      return false;
    }

    try {
      const remoteVaultKey = this.deps.getRemoteVaultKey();
      const { platform, mobile } = detectPlatform();
      const { report, details } = await buildDeviceReport({
        now: this.now(),
        platform,
        mobile,
        pluginVersion: this.deps.plugin.manifest.version,
        obsidianVersion: typeof apiVersion === "string" ? apiVersion : "",
        status: this.deps.health.getSyncStatus(),
        cursor: await store.getCursor(),
        health: this.deps.health.tracker.snapshot(),
        entries: await store.listReconcileEntryStates(),
        setAsideFiles: await this.deps.listSetAsideFiles(),
        skippedUnreadable: this.deps.countSkippedUnreadable(),
        rules: this.deps.getSyncFileRules(),
        recentProblems: this.deps.health.listRecentProblems(),
        deviceLabel: describePlatform(platform, mobile),
        vaultName: this.deps.plugin.app.vault.getName(),
        digest: async (data) => await computeVaultKeyedDigest(remoteVaultKey, data),
        isSyncedHere: this.deps.isSyncedHere,
      });

      const now = this.now();
      const signature = JSON.stringify({ ...report, generatedAt: 0 }) + JSON.stringify(details);
      if (
        !force &&
        this.lastSent?.signature === signature &&
        now - this.lastSent.at < RESEND_UNCHANGED_AFTER_MS
      ) {
        return true;
      }

      const { response } = await this.deps.requestClient.request({
        path: (token) => `/v1/vaults/${encodeURIComponent(token.vaultId)}/device-report`,
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: await this.encodeBody(report, details, remoteVaultKey),
      });
      await this.deps.health.tracker.persist();
      const sent = response.status >= 200 && response.status < 300;
      if (sent) {
        this.lastSent = { signature, at: now };
      }
      return sent;
    } catch {
      // Reporting is a side channel. It must never become a sync error or a
      // notice of its own; the next report is minutes away.
      return false;
    }
  }

  private async encodeBody(
    report: DeviceReport,
    details: DeviceReportDetails,
    remoteVaultKey: Uint8Array,
  ): Promise<string> {
    // Bound to the vault and device the server will file this under, which
    // is what the sync token names. A refreshed token names the same pair.
    const token = await this.deps.getSyncToken();
    const envelope = await encryptDeviceReportDetails(
      remoteVaultKey,
      new TextEncoder().encode(JSON.stringify(details)),
      { vaultId: token.vaultId, localVaultId: token.localVaultId },
    );
    return JSON.stringify({ report, details: envelope });
  }

  private async decryptDetails(
    token: SyncTokenResponse,
    localVaultId: string,
    envelope: string | null,
  ): Promise<{ details: DeviceReportDetails | null; error: string | null }> {
    if (!envelope) {
      return { details: null, error: null };
    }
    try {
      const plaintext = await decryptDeviceReportDetails(this.deps.getRemoteVaultKey(), envelope, {
        vaultId: token.vaultId,
        localVaultId,
      });
      return { details: JSON.parse(new TextDecoder().decode(plaintext)) as DeviceReportDetails, error: null };
    } catch (error) {
      return { details: null, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

function detectPlatform(): { platform: DevicePlatform; mobile: boolean } {
  const platform = Platform as typeof Platform & {
    isMacOS?: boolean;
    isWin?: boolean;
    isLinux?: boolean;
  };
  if (platform.isAndroidApp) {
    return { platform: "android", mobile: true };
  }
  if (platform.isIosApp) {
    return { platform: "ios", mobile: true };
  }
  if (platform.isMacOS) {
    return { platform: "macos", mobile: platform.isMobile };
  }
  if (platform.isWin) {
    return { platform: "windows", mobile: platform.isMobile };
  }
  if (platform.isLinux) {
    return { platform: "linux", mobile: platform.isMobile };
  }
  return { platform: "unknown", mobile: platform.isMobile };
}

interface ReportRow {
  localVaultId: string;
  isRequestingDevice: boolean;
  reportedAt: number;
  report: DeviceReport | null;
  details: string | null;
}

function readReportRows(json: unknown): ReportRow[] {
  if (!json || typeof json !== "object" || !Array.isArray((json as { reports?: unknown }).reports)) {
    return [];
  }
  return ((json as { reports: unknown[] }).reports).flatMap((value) => {
    if (!value || typeof value !== "object") {
      return [];
    }
    const row = value as Record<string, unknown>;
    if (typeof row.localVaultId !== "string" || typeof row.reportedAt !== "number") {
      return [];
    }
    return [
      {
        localVaultId: row.localVaultId,
        isRequestingDevice: row.isRequestingDevice === true,
        reportedAt: row.reportedAt,
        report: isDeviceReport(row.report) ? row.report : null,
        details: typeof row.details === "string" ? row.details : null,
      },
    ];
  });
}

function isDeviceReport(value: unknown): value is DeviceReport {
  if (!value || typeof value !== "object") {
    return false;
  }
  const report = value as Record<string, unknown>;
  return (
    report.schema === 1 &&
    typeof report.platform === "string" &&
    typeof report.cursor === "number" &&
    typeof report.problems === "object" &&
    typeof report.rules === "object"
  );
}
