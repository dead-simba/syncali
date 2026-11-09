const NEVER_SYNC_RESERVED_SEGMENTS = new Set([
  ".git",
  ".trash",
  ".synch",
  "node_modules",
]);

const MACOS_FOLDER_ICON = /^Icon[\r\n]$/;

/**
 * How Obsidian marks a file that lives outside the vault.
 *
 * Since 1.14, desktop Obsidian can open a file from anywhere on disk. It
 * becomes a `TExternalFile` - a subclass of `TFile` - whose path is this
 * prefix followed by the file's real location, and while it is open Obsidian
 * watches it and fires the vault's own `modify` and `delete` events whenever it
 * changes on disk. Obsidian's file system adapter strips the prefix and
 * resolves the rest as an absolute path, so reading, writing or deleting one
 * of these paths touches the real file outside the vault.
 *
 * None of it is part of the vault. Previewing a draft from another project
 * uploaded it as `file:/Users/...`; Android cannot create a name containing
 * `:`, so every pull on the phone failed on it and nothing after it arrived.
 * Obsidian's own test is a case-sensitive prefix match, and so is this one.
 */
const OBSIDIAN_EXTERNAL_FILE_PREFIX = "file:";

export type SyncPathSafetyClass =
  | "normal"
  | "reserved-never-sync"
  | "reserved-config-managed";

export function classifySyncPath(
  path: string,
  configDir = ".obsidian",
): SyncPathSafetyClass {
  const normalized = normalizeReservedPath(path);
  if (!normalized) {
    return "normal";
  }

  if (isObsidianExternalFilePath(normalized)) {
    return "reserved-never-sync";
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => NEVER_SYNC_RESERVED_SEGMENTS.has(segment))) {
    return "reserved-never-sync";
  }

  // macOS writes a custom folder icon to a file literally named "Icon" with a
  // trailing carriage return. It is not anyone's note, and Android cannot
  // create a filename containing one - so syncing it produced FILE_NOTCREATED
  // on every pass, forever, on a file no one would miss.
  if (segments.some((segment) => MACOS_FOLDER_ICON.test(segment))) {
    return "reserved-never-sync";
  }

  if (segments[0] === configDir) {
    return "reserved-config-managed";
  }

  return "normal";
}

export function isReservedSyncPath(path: string): boolean {
  return classifySyncPath(path) !== "normal";
}

export function isNeverSyncReservedPath(path: string): boolean {
  return classifySyncPath(path) === "reserved-never-sync";
}

/** A file Obsidian has open from outside the vault. See the prefix above. */
export function isObsidianExternalFilePath(path: string): boolean {
  return path.startsWith(OBSIDIAN_EXTERNAL_FILE_PREFIX);
}

function normalizeReservedPath(path: string): string {
  // Not trimmed: a leading or trailing space is part of a real filename, and
  // rewriting it here would classify a path that does not exist.
  return path.replace(/^\/+/, "").replace(/\/+$/, "");
}
