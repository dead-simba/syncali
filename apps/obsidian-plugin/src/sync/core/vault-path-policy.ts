import { shouldSyncPath, type SyncFileRules } from "./file-rules";
import { classifySyncPath } from "./reserved-paths";
import {
  isDeniedVaultConfigPath,
  shouldSyncVaultConfigPath,
  type VaultConfigSyncRules,
} from "./vault-config-rules";

const DEFAULT_OBSIDIAN_CONFIG_DIR = ".obsidian";

export type VaultPathPolicyDecision =
  | { kind: "sync" }
  | { kind: "ignore-local" }
  | { kind: "forbidden" };

export interface VaultPathPolicyRules {
  fileRules: SyncFileRules;
  vaultConfigRules: VaultConfigSyncRules;
}

export function decideVaultPathSync(
  path: string,
  rules: VaultPathPolicyRules,
): VaultPathPolicyDecision {
  const safetyClass = classifySyncPath(path, rules.vaultConfigRules.configDir);
  if (
    safetyClass === "reserved-never-sync" ||
    isDeniedVaultConfigPath(path, rules.vaultConfigRules.configDir) ||
    isProtectedDefaultConfigPath(path, rules.vaultConfigRules.configDir)
  ) {
    return { kind: "forbidden" };
  }

  if (safetyClass === "reserved-config-managed") {
    return shouldSyncVaultConfigPath(path, rules.vaultConfigRules)
      ? { kind: "sync" }
      : { kind: "ignore-local" };
  }

  if (shouldSyncPath(path, rules.fileRules)) {
    return { kind: "sync" };
  }

  return { kind: "ignore-local" };
}

/**
 * Whether an incoming remote path may be written to this vault.
 *
 * File sync rules are per-device and describe what this device syncs, not what
 * it uploads - the settings read "Sync video attachments on this device". They
 * must therefore gate the pull as well as the push. Consulting only the vault
 * config rules meant a device that had turned a file type off still downloaded
 * and wrote every file of that type: the toggle appeared to do nothing, and on
 * mobile a large attachment the user had explicitly excluded could still
 * exhaust memory mid-pull.
 *
 * Entries rejected here are not dropped - `applySkippedRemoteStates` records
 * their remote state, so the sync cursor still advances past them and they
 * arrive if the rule is later turned back on.
 */
export function shouldApplyRemoteVaultPath(
  path: string,
  rules: VaultPathPolicyRules,
): boolean {
  const safetyClass = classifySyncPath(path, rules.vaultConfigRules.configDir);
  if (safetyClass === "reserved-never-sync") {
    return false;
  }

  if (
    isDeniedVaultConfigPath(path, rules.vaultConfigRules.configDir) ||
    isProtectedDefaultConfigPath(path, rules.vaultConfigRules.configDir)
  ) {
    return false;
  }

  if (safetyClass === "reserved-config-managed") {
    return shouldSyncVaultConfigPath(path, rules.vaultConfigRules);
  }

  return shouldSyncPath(path, rules.fileRules);
}

export function isForbiddenVaultPath(
  path: string,
  vaultConfigRules: Pick<VaultConfigSyncRules, "configDir">,
): boolean {
  return (
    classifySyncPath(path, vaultConfigRules.configDir) ===
      "reserved-never-sync" ||
    isDeniedVaultConfigPath(path, vaultConfigRules.configDir) ||
    isProtectedDefaultConfigPath(path, vaultConfigRules.configDir)
  );
}

function isProtectedDefaultConfigPath(path: string, configDir: string): boolean {
  if (configDir === DEFAULT_OBSIDIAN_CONFIG_DIR) {
    return false;
  }

  return classifySyncPath(path, DEFAULT_OBSIDIAN_CONFIG_DIR) !== "normal";
}
