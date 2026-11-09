import { describe, expect, it } from "vitest";

import { TFile } from "obsidian";

import { asSyncableFile } from "../vault/vault-files";
import { removeVaultPathIfExists, writeVaultBytes } from "../vault/vault-writer";
import { DEFAULT_SYNC_FILE_RULES, shouldSyncPath } from "./file-rules";
import { isNeverSyncReservedPath } from "./reserved-paths";
import { DEFAULT_VAULT_CONFIG_SYNC_RULES } from "./vault-config-rules";
import { decideVaultPathSync, shouldApplyRemoteVaultPath } from "./vault-path-policy";

/**
 * Desktop Obsidian (1.14+) can open a file from outside the vault. Plugins see
 * it as a TFile whose path is "file:" plus its real location, and get the
 * vault's own modify events while it is open. Previewing a draft from another
 * project uploaded it; the phone could not create a name containing ":", and
 * every pull failed on it from then on.
 */
const EXTERNAL =
  "file:/Users/alitahir/Documents/Development/Claude Code/Understanding-Quran-Words/Understanding-Quran-Words/behind/2026-10-19-alhamdulillah.md";

const rules = {
  fileRules: DEFAULT_SYNC_FILE_RULES,
  vaultConfigRules: DEFAULT_VAULT_CONFIG_SYNC_RULES,
};

describe("a file Obsidian has open from outside the vault", () => {
  it("is never synced", () => {
    expect(isNeverSyncReservedPath(EXTERNAL)).toBe(true);
    expect(decideVaultPathSync(EXTERNAL, rules).kind).toBe("forbidden");
  });

  it("is not uploaded when Obsidian reports it changed", () => {
    expect(shouldSyncPath(EXTERNAL, DEFAULT_SYNC_FILE_RULES)).toBe(false);
    expect(asSyncableFile(new TFile(EXTERNAL), DEFAULT_SYNC_FILE_RULES)).toBeNull();
  });

  it("is skipped when it arrives from the server, so the pull can move past it", () => {
    expect(shouldApplyRemoteVaultPath(EXTERNAL, rules)).toBe(false);
  });

  it("is never written or deleted, because the path resolves outside the vault", async () => {
    const touched: string[] = [];
    const writer = {
      exists: async () => true,
      mkdir: async (path: string) => {
        touched.push(path);
      },
      writeText: async (path: string) => {
        touched.push(path);
      },
      writeBinary: async (path: string) => {
        touched.push(path);
      },
      remove: async (path: string) => {
        touched.push(path);
      },
    };

    await expect(writeVaultBytes(writer, EXTERNAL, new Uint8Array())).rejects.toThrow(
      "Refusing to modify reserved vault path",
    );
    await expect(removeVaultPathIfExists(writer, EXTERNAL)).rejects.toThrow(
      "Refusing to modify reserved vault path",
    );
    expect(touched).toEqual([]);
  });

  it("does not catch a vault note that merely contains the word", () => {
    expect(isNeverSyncReservedPath("Notes/file: what to keep.md")).toBe(false);
    expect(isNeverSyncReservedPath("filed notes.md")).toBe(false);
    expect(isNeverSyncReservedPath("Archive/file:/old.md")).toBe(false);
    expect(shouldSyncPath("Notes/file: what to keep.md", DEFAULT_SYNC_FILE_RULES)).toBe(true);
  });
});
