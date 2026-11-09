import { describe, expect, it } from "vitest";

import {
  assessDevice,
  compareDeviceFiles,
  describePlatform,
  type DeviceReport,
} from "./device-verdict";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 9, 7, 15);

function report(overrides: Partial<DeviceReport> = {}): DeviceReport {
  return {
    schema: 1,
    generatedAt: NOW,
    platform: "android",
    mobile: true,
    pluginVersion: "0.3.29",
    obsidianVersion: "1.15.0",
    status: "up_to_date",
    cursor: 13_902,
    serverCursor: 13_902,
    activeSince: NOW - 3 * HOUR,
    lastSyncOkAt: NOW - 10 * 60_000,
    lastErrorAt: null,
    pendingUploads: 0,
    setAside: 0,
    skippedUnreadable: 0,
    problems: {},
    files: { count: 1590, digest: "a".repeat(64) },
    rules: { images: true, audio: true, videos: false, pdf: true, other: true, excludedFolders: 0 },
    ...overrides,
  };
}

describe("judging a device from its report", () => {
  it("calls the phone from 9 November stuck, and says since when and why", () => {
    // Alive and trying for hours, last finished a sync on 26 October, behind
    // the server, and failing the same way on every pull.
    const lastOk = Date.UTC(2026, 9, 26, 1, 0);
    const verdict = assessDevice({
      report: report({
        status: "attention_needed",
        cursor: 13_100,
        lastSyncOkAt: lastOk,
        lastErrorAt: NOW - 60_000,
        problems: {
          name_refused: { count: 1400, firstAt: lastOk + HOUR, lastAt: NOW - 60_000 },
        },
      }),
      reportedAt: NOW - 60_000,
      now: NOW,
    });

    expect(verdict.state).toBe("stuck");
    expect(verdict.headline).toMatch(/^Has not finished a sync since /);
    expect(verdict.reasons[0]).toBe("802 changes on the server it has not received");
    expect(verdict.reasons[1]).toMatch(
      /^Could not create a file whose name this device does not allow: 1,400 times since /,
    );
  });

  it("does not call a phone that has just woken up stuck", () => {
    // Last finished yesterday, behind, but only started trying five minutes ago.
    const verdict = assessDevice({
      report: report({
        cursor: 13_500,
        lastSyncOkAt: NOW - DAY,
        activeSince: NOW - 5 * 60_000,
      }),
      reportedAt: NOW - 60_000,
      now: NOW,
    });

    expect(verdict.state).toBe("catching_up");
    expect(verdict.headline).toBe("Catching up: 402 changes behind");
  });

  it("does not call a laptop that has had nothing to do for hours stuck", () => {
    const verdict = assessDevice({
      report: report({ platform: "macos", mobile: false, lastSyncOkAt: NOW - 5 * HOUR }),
      reportedAt: NOW - 60_000,
      now: NOW,
    });

    expect(verdict.state).toBe("up_to_date");
    expect(verdict.headline).toBe("Up to date, last synced 5 hours ago");
  });

  it("sees a device is behind from another device's view of the server", () => {
    // A device that stopped hearing broadcasts thinks the server is where it is.
    const verdict = assessDevice({
      report: report({ cursor: 13_000, serverCursor: 13_000 }),
      reportedAt: NOW - 60_000,
      now: NOW,
      latestServerCursor: 13_902,
    });

    expect(verdict.state).toBe("catching_up");
  });

  it("reads a device that has gone quiet as asleep, not broken", () => {
    const verdict = assessDevice({
      report: report({ setAside: 1 }),
      reportedAt: NOW - 2 * DAY,
      now: NOW,
    });

    expect(verdict.state).toBe("quiet");
    expect(verdict.headline).toBe("Not heard from in 2 days");
    expect(verdict.reasons).toEqual([
      "At its last report: 1 file set aside, listed under Files not syncing",
    ]);
  });

  it("points at files set aside even when everything else is current", () => {
    const verdict = assessDevice({
      report: report({ setAside: 2, skippedUnreadable: 1 }),
      reportedAt: NOW - 60_000,
      now: NOW,
    });

    expect(verdict.state).toBe("needs_attention");
    expect(verdict.headline).toBe("3 files not syncing");
  });

  it("names platforms the way a person would", () => {
    expect(describePlatform("android", true)).toBe("Android phone");
    expect(describePlatform("macos", false)).toBe("Mac");
    expect(describePlatform("unknown", false)).toBe("Device");
  });
});

describe("comparing what devices hold", () => {
  const upToDate = { state: "up_to_date" as const, headline: "", reasons: [] };

  it("notices two up-to-date devices holding different files", () => {
    const notes = compareDeviceFiles([
      { label: "Mac", report: report({ files: { count: 1598, digest: "a".repeat(64) } }), verdict: upToDate },
      { label: "Android phone", report: report({ files: { count: 1590, digest: "b".repeat(64) } }), verdict: upToDate },
    ]);

    expect(notes).toEqual([
      "Mac holds 1,598 files and Android phone holds 1,590 files, and their contents differ, though both say they are up to date.",
    ]);
  });

  it("expects devices with different file rules to differ", () => {
    const notes = compareDeviceFiles([
      { label: "Mac", report: report({ files: { count: 1598, digest: "a".repeat(64) } }), verdict: upToDate },
      {
        label: "Android phone",
        report: report({
          files: { count: 1500, digest: "b".repeat(64) },
          rules: { images: true, audio: true, videos: true, pdf: true, other: true, excludedFolders: 0 },
        }),
        verdict: upToDate,
      },
    ]);

    expect(notes).toEqual([]);
  });
});
