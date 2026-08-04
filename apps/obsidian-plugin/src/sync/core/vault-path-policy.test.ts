import { describe, expect, it } from "vitest";

import { DEFAULT_SYNC_FILE_RULES } from "./file-rules";
import { DEFAULT_VAULT_CONFIG_SYNC_RULES } from "./vault-config-rules";
import {
  decideVaultPathSync,
  isForbiddenVaultPath,
  shouldApplyRemoteVaultPath,
} from "./vault-path-policy";

describe("decideVaultPathSync", () => {
  it("syncs normal vault files selected by file rules", () => {
    expect(
      decideVaultPathSync("Notes/daily.md", {
        fileRules: DEFAULT_SYNC_FILE_RULES,
        vaultConfigRules: DEFAULT_VAULT_CONFIG_SYNC_RULES,
      }).kind,
    ).toBe("sync");
  });

  it("syncs selected vault config files without treating disabled hidden paths as forbidden", () => {
    const vaultConfigRules = {
      ...DEFAULT_VAULT_CONFIG_SYNC_RULES,
      enabled: true,
    };

    expect(
      decideVaultPathSync(".obsidian/app.json", {
        fileRules: DEFAULT_SYNC_FILE_RULES,
        vaultConfigRules,
      }).kind,
    ).toBe("sync");
    expect(
      decideVaultPathSync(".assets/file.md", {
        fileRules: DEFAULT_SYNC_FILE_RULES,
        vaultConfigRules,
      }).kind,
    ).toBe("ignore-local");
  });

  it("does not let file rules bypass custom vault config rules", () => {
    const vaultConfigRules = {
      ...DEFAULT_VAULT_CONFIG_SYNC_RULES,
      enabled: false,
      configDir: ".obsidian-mobile",
    };

    expect(
      decideVaultPathSync(".obsidian-mobile/app.json", {
        fileRules: {
          ...DEFAULT_SYNC_FILE_RULES,
          includedHiddenFolders: [".obsidian-mobile"],
        },
        vaultConfigRules,
      }).kind,
    ).toBe("ignore-local");
    expect(
      decideVaultPathSync(".obsidian/app.json", {
        fileRules: DEFAULT_SYNC_FILE_RULES,
        vaultConfigRules,
      }).kind,
    ).toBe("forbidden");
  });

  it("marks never-sync and device-local config paths as forbidden", () => {
    expect(isForbiddenVaultPath(".git/config", DEFAULT_VAULT_CONFIG_SYNC_RULES)).toBe(
      true,
    );
    expect(
      isForbiddenVaultPath(
        ".obsidian/workspace.json",
        DEFAULT_VAULT_CONFIG_SYNC_RULES,
      ),
    ).toBe(true);
    expect(
      isForbiddenVaultPath(
        ".obsidian/plugins/syncali/data.json",
        DEFAULT_VAULT_CONFIG_SYNC_RULES,
      ),
    ).toBe(true);
    expect(
      isForbiddenVaultPath(".obsidian/app.json", DEFAULT_VAULT_CONFIG_SYNC_RULES),
    ).toBe(false);
  });

  it("keeps the default Obsidian config folder protected when another config folder is active", () => {
    const vaultConfigRules = {
      ...DEFAULT_VAULT_CONFIG_SYNC_RULES,
      enabled: true,
      configDir: ".obsidian-mobile",
    };

    expect(isForbiddenVaultPath(".obsidian/app.json", vaultConfigRules)).toBe(true);
    expect(
      isForbiddenVaultPath(".obsidian/workspace.json", vaultConfigRules),
    ).toBe(true);
    expect(
      isForbiddenVaultPath(".obsidian-mobile/app.json", vaultConfigRules),
    ).toBe(false);
  });
});

describe("shouldApplyRemoteVaultPath", () => {
  it("keeps normal remote files eligible while honoring vault config rules", () => {
    expect(
      shouldApplyRemoteVaultPath("Notes/daily.md", {
        fileRules: DEFAULT_SYNC_FILE_RULES,
        vaultConfigRules: DEFAULT_VAULT_CONFIG_SYNC_RULES,
      }),
    ).toBe(true);
    expect(
      shouldApplyRemoteVaultPath(".obsidian/app.json", {
        fileRules: DEFAULT_SYNC_FILE_RULES,
        vaultConfigRules: DEFAULT_VAULT_CONFIG_SYNC_RULES,
      }),
    ).toBe(false);
    expect(
      shouldApplyRemoteVaultPath(".obsidian/app.json", {
        fileRules: DEFAULT_SYNC_FILE_RULES,
        vaultConfigRules: {
          ...DEFAULT_VAULT_CONFIG_SYNC_RULES,
          enabled: true,
        },
      }),
    ).toBe(true);
  });

  it("does not apply default Obsidian config paths as generic remote files when using a custom config folder", () => {
    const vaultConfigRules = {
      ...DEFAULT_VAULT_CONFIG_SYNC_RULES,
      enabled: true,
      configDir: ".obsidian-mobile",
    };

    expect(
      shouldApplyRemoteVaultPath(".obsidian/app.json", {
        fileRules: DEFAULT_SYNC_FILE_RULES,
        vaultConfigRules,
      }),
    ).toBe(false);
    expect(
      shouldApplyRemoteVaultPath(".obsidian-mobile/app.json", {
        fileRules: DEFAULT_SYNC_FILE_RULES,
        vaultConfigRules,
      }),
    ).toBe(true);
  });

  it("honors this device's file type rules for incoming files", () => {
    // The toggle reads "Sync video attachments on this device". Gating only the
    // push meant a device that turned videos off still downloaded every one of
    // them - on mobile, large enough to exhaust memory mid-pull.
    const noVideos = { ...DEFAULT_SYNC_FILE_RULES, includeVideos: false };

    expect(
      shouldApplyRemoteVaultPath("Attachments/clip.mp4", {
        fileRules: DEFAULT_SYNC_FILE_RULES,
        vaultConfigRules: DEFAULT_VAULT_CONFIG_SYNC_RULES,
      }),
    ).toBe(true);
    expect(
      shouldApplyRemoteVaultPath("Attachments/clip.mp4", {
        fileRules: noVideos,
        vaultConfigRules: DEFAULT_VAULT_CONFIG_SYNC_RULES,
      }),
    ).toBe(false);
    // Markdown is never gated by a file type rule.
    expect(
      shouldApplyRemoteVaultPath("Notes/daily.md", {
        fileRules: noVideos,
        vaultConfigRules: DEFAULT_VAULT_CONFIG_SYNC_RULES,
      }),
    ).toBe(true);
    // An excluded folder must not arrive from a peer either.
    expect(
      shouldApplyRemoteVaultPath("Archive/old.md", {
        fileRules: { ...DEFAULT_SYNC_FILE_RULES, excludedFolders: ["Archive"] },
        vaultConfigRules: DEFAULT_VAULT_CONFIG_SYNC_RULES,
      }),
    ).toBe(false);
  });
});
