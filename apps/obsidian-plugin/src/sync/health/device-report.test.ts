import { describe, expect, it } from "vitest";

import { computeVaultKeyedDigest } from "../core/crypto";
import { DEFAULT_SYNC_FILE_RULES } from "../core/file-rules";
import type { SyncReconcileEntryState } from "../store/store";
import { buildDeviceReport, fingerprintFiles, listNotYetSynced } from "./device-report";

const KEY = new Uint8Array(32).fill(7);
const digest = async (data: Uint8Array) => await computeVaultKeyedDigest(KEY, data);

function entry(
  entryId: string,
  options: {
    local?: { path: string; hash: string } | null;
    remote?: { path: string; hash: string; revision?: number; deleted?: boolean } | null;
    dirty?: "pending" | "blocked";
  },
): SyncReconcileEntryState {
  return {
    entryId,
    local: options.local
      ? {
          entryId,
          path: options.local.path,
          blobId: null,
          hash: options.local.hash,
          deleted: false,
          updatedAt: 1,
          localMtime: 1,
          localSize: 1,
        }
      : null,
    remote: options.remote
      ? {
          entryId,
          path: options.remote.path,
          revision: options.remote.revision ?? 1,
          blobId: "blob",
          hash: options.remote.hash,
          deleted: options.remote.deleted ?? false,
          updatedAt: 1,
        }
      : null,
    dirty: options.dirty
      ? {
          mutationId: `m-${entryId}`,
          entryId,
          op: "upsert",
          status: options.dirty,
          baseRevision: 1,
          blobId: null,
          hash: null,
          encryptedMetadata: "",
          createdAt: 1,
        }
      : null,
  };
}

const PRIVATE_PATHS = [
  "My Life/Journal/2026-11-09 private.md",
  "Islam/Seerah/Battle of Ridda.md",
  "+/Mindset Accelator Notes.md",
  "Videos/clip.mp4",
];

async function build(overrides: Partial<Parameters<typeof buildDeviceReport>[0]> = {}) {
  return await buildDeviceReport({
    now: 1_794_220_000_000,
    platform: "android",
    mobile: true,
    pluginVersion: "0.3.29",
    obsidianVersion: "1.15.0",
    status: "attention_needed",
    cursor: 13_100,
    health: {
      activeSince: 1_794_210_000_000,
      lastSyncOkAt: 1_793_000_000_000,
      lastErrorAt: 1_794_219_000_000,
      serverCursor: 13_902,
      problems: { name_refused: { count: 1400, firstAt: 1, lastAt: 2 } },
    },
    entries: [
      entry("journal", {
        local: { path: PRIVATE_PATHS[0] ?? "", hash: "h1" },
        remote: { path: PRIVATE_PATHS[0] ?? "", hash: "h1" },
      }),
      entry("ridda", { local: { path: PRIVATE_PATHS[1] ?? "", hash: "h2" }, remote: null, dirty: "pending" }),
      entry("mindset", {
        local: { path: PRIVATE_PATHS[2] ?? "", hash: "old" },
        remote: { path: PRIVATE_PATHS[2] ?? "", hash: "new" },
      }),
      entry("video", { local: null, remote: { path: PRIVATE_PATHS[3] ?? "", hash: "v" } }),
    ],
    setAsideFiles: [{ path: "Notes/Why?.md", op: "upsert", reason: "prepare_failed" }],
    skippedUnreadable: 1,
    // A device that leaves videos out, like the laptop in this vault.
    rules: { ...DEFAULT_SYNC_FILE_RULES, includeVideos: false },
    recentProblems: [
      {
        at: 2,
        firstAt: 1,
        count: 1400,
        message: 'write failed for "file:/Users/alitahir/Documents/draft.md": FILE_NOTCREATED',
      },
    ],
    deviceLabel: "Android phone",
    vaultName: "Ideaverse-AliTahir",
    digest,
    isSyncedHere: (path) => !path.endsWith(".mp4"),
    ...overrides,
  });
}

describe("a device report", () => {
  it("keeps every file name, error and vault name out of the readable half", async () => {
    const { report } = await build();
    const readable = JSON.stringify(report);

    for (const secret of [
      ...PRIVATE_PATHS,
      "Journal",
      "Why?",
      "file:/Users",
      "FILE_NOTCREATED",
      "Ideaverse",
    ]) {
      expect(readable).not.toContain(secret);
    }
  });

  it("carries the counts a verdict needs", async () => {
    const { report } = await build();

    expect(report).toMatchObject({
      platform: "android",
      status: "attention_needed",
      cursor: 13_100,
      serverCursor: 13_902,
      activeSince: 1_794_210_000_000,
      pendingUploads: 1,
      setAside: 1,
      skippedUnreadable: 1,
      problems: { name_refused: { count: 1400, firstAt: 1, lastAt: 2 } },
      files: { count: 3 },
      rules: { videos: false, excludedFolders: 0 },
    });
    expect(report.files?.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("puts the names in the private half, where they help", async () => {
    const { details } = await build();

    expect(details.setAside).toEqual([
      { path: "Notes/Why?.md", op: "upsert", reason: "prepare_failed" },
    ]);
    expect(details.recentProblems[0]).toMatchObject({ count: 1400, firstAt: 1 });
    expect(details.notYetSynced).toEqual([
      { path: "+/Mindset Accelator Notes.md", state: "differs" },
      { path: "Islam/Seerah/Battle of Ridda.md", state: "waiting_to_upload" },
    ]);
    expect(details.notYetSyncedTotal).toBe(2);
    expect(details.folders.map((folder) => [folder.folder, folder.files])).toEqual([
      ["+", 1],
      ["Islam", 1],
      ["My Life", 1],
    ]);
  });

  it("refuses free text where only a code belongs", async () => {
    const { report } = await build({ status: "Journal/private.md", pluginVersion: "0.3 dev build" });

    expect(report.status).toBe("");
    expect(report.pluginVersion).toBe("");
  });
});

describe("the file fingerprint", () => {
  const files = [
    { path: "b.md", hash: "2" },
    { path: "a.md", hash: "1" },
    { path: "Folder/c.md", hash: "3" },
  ];

  it("does not depend on the order files are listed in", async () => {
    const forward = await fingerprintFiles(files, digest);
    const backward = await fingerprintFiles([...files].reverse(), digest);

    expect(forward).toEqual(backward);
    expect(forward.count).toBe(3);
  });

  it("changes when one file's contents change, and only in that folder", async () => {
    const before = await fingerprintFiles(files, digest);
    const after = await fingerprintFiles(
      files.map((file) => (file.path === "Folder/c.md" ? { ...file, hash: "changed" } : file)),
      digest,
    );

    expect(after.digest).not.toBe(before.digest);
    const folder = (fingerprint: typeof before, name: string) =>
      fingerprint.folders.find((entry) => entry.folder === name)?.digest;
    expect(folder(after, "Folder")).not.toBe(folder(before, "Folder"));
    expect(folder(after, "/")).toBe(folder(before, "/"));
  });

  it("cannot be reproduced without the vault key", async () => {
    const withKey = await fingerprintFiles(files, digest);
    const otherKey = await fingerprintFiles(files, async (data) =>
      computeVaultKeyedDigest(new Uint8Array(32).fill(8), data),
    );

    expect(otherKey.digest).not.toBe(withKey.digest);
  });
});

describe("files not yet in sync", () => {
  it("does not count a file this device leaves out on purpose", () => {
    const listed = listNotYetSynced(
      [entry("video", { local: null, remote: { path: "Videos/clip.mp4", hash: "v" } })],
      (path) => !path.endsWith(".mp4"),
    );

    expect(listed).toEqual([]);
  });

  it("does not count a file deleted on the server", () => {
    const listed = listNotYetSynced([
      entry("gone", { local: null, remote: { path: "Old.md", hash: "x", deleted: true } }),
    ]);

    expect(listed).toEqual([]);
  });
});
