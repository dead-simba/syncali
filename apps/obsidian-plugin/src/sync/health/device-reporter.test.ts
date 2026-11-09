import { afterEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";

import { decryptDeviceReportDetails } from "../core/crypto";
import { DEFAULT_SYNC_FILE_RULES } from "../core/file-rules";
import type { SyncTokenResponse } from "../remote/client";
import type { SyncAuthorizedRequestInput } from "../remote/request-client";
import type { SyncReconcileEntryState } from "../store/store";
import { DeviceReporter, STUCK_CHECK_INTERVAL_MS, type DeviceReporterTimers } from "./device-reporter";
import { SyncHealthTracker } from "./health-tracker";

const KEY = new Uint8Array(32).fill(9);
const HOUR = 60 * 60 * 1000;

/** Stands in for the server: keeps the latest PUT from each device. */
class FakeServer {
  readonly rows = new Map<string, { reportedAt: number; report: unknown; details: string | null }>();
  readonly requests: Array<{ method: string; path: string }> = [];

  constructor(private readonly clock: () => number) {}

  client(token: SyncTokenResponse, fail = false) {
    return {
      request: async (input: SyncAuthorizedRequestInput) => {
        if (fail) {
          throw new Error("net::ERR_CONNECTION_RESET");
        }
        const path = input.path(token);
        const method = input.method ?? "GET";
        this.requests.push({ method, path });
        if (method === "PUT") {
          const body = JSON.parse(String(input.body)) as { report: unknown; details: string | null };
          this.rows.set(token.localVaultId, { reportedAt: this.clock(), ...body });
          return { response: { status: 204, json: null }, token };
        }
        return {
          response: {
            status: 200,
            json: {
              reports: [...this.rows.entries()].map(([localVaultId, row]) => ({
                localVaultId,
                isRequestingDevice: localVaultId === token.localVaultId,
                ...row,
              })),
            },
          },
          token,
        };
      },
    };
  }
}

function memoryStore() {
  let stored: unknown;
  return {
    initialize: async () => {},
    read: () => stored,
    write: (_key: string, value: unknown) => {
      stored = value;
    },
    save: async () => {},
  };
}

function token(localVaultId: string): SyncTokenResponse {
  return { token: "t", expiresAt: 0, vaultId: "vault-1", localVaultId, syncFormatVersion: 2 };
}

function capturingTimers() {
  const intervals: Array<{ callback: () => void; ms: number }> = [];
  const timers: DeviceReporterTimers = {
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: (callback, ms) => {
      intervals.push({ callback, ms });
      return intervals.length;
    },
    clearInterval: () => {},
  };
  return { timers, intervals };
}

function createReporter(options: {
  server: FakeServer;
  clock: () => number;
  localVaultId: string;
  features?: string[];
  entries?: SyncReconcileEntryState[];
  setAside?: Array<{ path: string; reason: string }>;
  status?: string;
  cursor?: number;
  fail?: boolean;
  tracker?: SyncHealthTracker;
  notifyStuckDevice?: (message: string) => void;
  writeLocalReports?: (contents: string) => Promise<void>;
  timers?: DeviceReporterTimers;
}) {
  const tracker = options.tracker ?? new SyncHealthTracker(memoryStore() as never, options.clock);
  const reporter = new DeviceReporter({
    plugin: {
      manifest: { version: "0.3.29" },
      app: { vault: { getName: () => "Ideaverse-AliTahir" } },
    } as never,
    health: {
      tracker,
      listRecentProblems: () => [
        { at: 2, firstAt: 1, count: 1400, message: 'write failed for "Notes/Why?.md": FILE_NOTCREATED' },
      ],
      getSyncStatus: () => options.status ?? "up_to_date",
      notifyStuckDevice: options.notifyStuckDevice,
      writeLocalReports: options.writeLocalReports,
    },
    getStore: () =>
      ({
        getCursor: async () => options.cursor ?? 13_902,
        listReconcileEntryStates: async () => options.entries ?? [],
      }) as never,
    getRemoteVaultKey: () => KEY,
    getSyncFileRules: () => DEFAULT_SYNC_FILE_RULES,
    isSyncedHere: () => true,
    getLiveSession: () => ({ features: options.features ?? ["device_reports"] }) as never,
    getSyncToken: async () => token(options.localVaultId),
    requestClient: options.server.client(token(options.localVaultId), options.fail),
    listSetAsideFiles: async () => options.setAside ?? [],
    countSkippedUnreadable: () => 0,
    now: options.clock,
    timers: options.timers ?? capturingTimers().timers,
  });
  return { reporter, tracker };
}

describe("the device reporter", () => {
  const androidBefore = Platform.isAndroidApp;
  afterEach(() => {
    (Platform as { isAndroidApp: boolean }).isAndroidApp = androidBefore;
  });

  it("sends nothing to a server that does not keep reports", async () => {
    const clock = () => 1_000;
    const server = new FakeServer(clock);
    const { reporter } = createReporter({ server, clock, localVaultId: "laptop", features: [] });

    expect(await reporter.reportNow()).toBe(false);
    expect(await reporter.fetchReports()).toBeNull();
    expect(server.requests).toEqual([]);
  });

  it("sends counts the server can read and names only the vault key can", async () => {
    const clock = () => 1_000;
    const server = new FakeServer(clock);
    const { reporter } = createReporter({
      server,
      clock,
      localVaultId: "laptop",
      setAside: [{ path: "Journal/private.md", reason: "prepare_failed" }],
    });

    expect(await reporter.reportNow()).toBe(true);
    const row = server.rows.get("laptop");
    expect(server.requests).toEqual([{ method: "PUT", path: "/v1/vaults/vault-1/device-report" }]);
    expect(JSON.stringify(row?.report)).not.toContain("Journal");
    expect(row?.details).not.toContain("Journal");

    const details = JSON.parse(
      new TextDecoder().decode(
        await decryptDeviceReportDetails(KEY, row?.details ?? "", {
          vaultId: "vault-1",
          localVaultId: "laptop",
        }),
      ),
    ) as { setAside: Array<{ path: string }>; vaultName: string };
    expect(details.setAside[0]?.path).toBe("Journal/private.md");
    expect(details.vaultName).toBe("Ideaverse-AliTahir");
  });

  it("reads the phone's report on the laptop, decrypted and judged, and keeps a copy", async () => {
    let now = 0;
    const clock = () => now;
    const server = new FakeServer(clock);

    (Platform as { isAndroidApp: boolean }).isAndroidApp = true;
    const phone = createReporter({
      server,
      clock,
      localVaultId: "phone",
      status: "attention_needed",
      cursor: 13_100,
    });
    phone.tracker.markActive();
    phone.tracker.recordServerCursor(13_902);
    now = 2 * HOUR;
    phone.tracker.recordProblem("name_refused");
    await phone.reporter.reportNow();
    (Platform as { isAndroidApp: boolean }).isAndroidApp = false;

    const written: string[] = [];
    const laptop = createReporter({
      server,
      clock,
      localVaultId: "laptop",
      writeLocalReports: async (contents) => {
        written.push(contents);
      },
    });
    const snapshot = await laptop.reporter.fetchReports();

    const phoneView = snapshot?.devices.find((device) => device.localVaultId === "phone");
    expect(phoneView).toMatchObject({
      isThisDevice: false,
      label: "Android phone",
      verdict: { state: "stuck", headline: "Has not finished a sync" },
      detailsError: null,
    });
    expect(phoneView?.details?.recentProblems[0]?.message).toContain("FILE_NOTCREATED");
    expect(snapshot?.devices.find((device) => device.localVaultId === "laptop")?.isThisDevice).toBe(
      true,
    );
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("Has not finished a sync");
  });

  it("warns once about another device that is stuck, and never about itself", async () => {
    const T0 = 1_794_000_000_000;
    let now = T0;
    const clock = () => now;
    const server = new FakeServer(clock);
    const notices: string[] = [];
    const { timers, intervals } = capturingTimers();

    // Both devices start trying at T0 and neither finishes: by the same rules
    // the laptop is stuck too, and it must not warn about itself.
    (Platform as { isAndroidApp: boolean }).isAndroidApp = true;
    const phone = createReporter({ server, clock, localVaultId: "phone", status: "attention_needed", cursor: 1 });
    phone.tracker.markActive();
    phone.tracker.recordServerCursor(5);
    (Platform as { isAndroidApp: boolean }).isAndroidApp = false;
    const laptopTracker = new SyncHealthTracker(memoryStore() as never, clock);
    laptopTracker.markActive();
    const laptop = createReporter({
      server,
      clock,
      localVaultId: "laptop",
      status: "attention_needed",
      tracker: laptopTracker,
      timers,
      notifyStuckDevice: (message) => notices.push(message),
    });

    now = T0 + 2 * HOUR;
    (Platform as { isAndroidApp: boolean }).isAndroidApp = true;
    await phone.reporter.reportNow();
    (Platform as { isAndroidApp: boolean }).isAndroidApp = false;

    laptop.reporter.start();
    const stuckCheck = intervals.find((interval) => interval.ms === STUCK_CHECK_INTERVAL_MS);
    now += 60_000;
    stuckCheck?.callback();
    await vi.waitFor(() => expect(notices).toHaveLength(1));

    // Half an hour later the phone is still stuck: no second warning today.
    now += STUCK_CHECK_INTERVAL_MS;
    stuckCheck?.callback();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(notices).toEqual([
      "Your Android phone has not finished a sync. Open Syncali settings, then Devices, to see why.",
    ]);
  });

  it("does not resend an unchanged report every ten minutes", async () => {
    let now = 1_000;
    const clock = () => now;
    const server = new FakeServer(clock);
    const { reporter } = createReporter({ server, clock, localVaultId: "laptop" });

    await reporter.reportNow();
    now += 10 * 60_000;
    await reporter.reportNow();
    expect(server.requests).toHaveLength(1);

    // Opening the Devices view always sends a fresh one...
    await reporter.reportNow({ force: true });
    expect(server.requests).toHaveLength(2);

    // ...and an hour on, an unchanged report goes again, so the device still
    // reads as alive.
    now += 61 * 60_000;
    await reporter.reportNow();
    expect(server.requests).toHaveLength(3);
  });

  it("never turns a failed report into an error", async () => {
    const clock = () => 1_000;
    const server = new FakeServer(clock);
    const { reporter } = createReporter({ server, clock, localVaultId: "laptop", fail: true });

    await expect(reporter.reportNow()).resolves.toBe(false);
  });
});
