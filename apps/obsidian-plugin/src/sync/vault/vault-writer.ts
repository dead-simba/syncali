import { isNeverSyncReservedPath } from "../core/reserved-paths";

/**
 * A vault filesystem operation that failed, carrying the path it failed on.
 *
 * Obsidian's mobile adapter reports write failures as bare platform codes -
 * `FILE_NOTCREATED` on Android when a name contains characters the filesystem
 * rejects (`" * : < > ? \ |`), and sometimes an exception with no message at
 * all. Neither names the file, so the notice the user sees is unactionable in
 * a vault of any size. Wrapping every vault mutation keeps the path attached.
 */
export class VaultWriteError extends Error {
  constructor(
    readonly operation: string,
    readonly path: string,
    readonly cause: unknown,
  ) {
    super(`${operation} failed for "${path}": ${describeCause(cause)}`);
    this.name = "VaultWriteError";
  }
}

function describeCause(cause: unknown): string {
  if (!(cause instanceof Error)) {
    const text = String(cause ?? "").trim();
    return text && text !== "[object Object]" ? text : "unknown error";
  }

  const message = cause.message.trim();
  const code =
    "code" in cause && typeof cause.code === "string" ? cause.code.trim() : "";
  return message || code || cause.name.trim() || "unknown error";
}

async function withPathContext<T>(
  operation: string,
  path: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw error instanceof VaultWriteError
      ? error
      : new VaultWriteError(operation, path, error);
  }
}

export interface SyncVaultWriter {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  writeText(path: string, content: string): Promise<void>;
  writeBinary(path: string, content: Uint8Array): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  remove(path: string): Promise<void>;
  isProtectedVaultPath?(path: string): boolean;
}

export async function writeVaultBytes(
  writer: Pick<
    SyncVaultWriter,
    "exists" | "mkdir" | "writeText" | "writeBinary" | "isProtectedVaultPath"
  >,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  assertWritableVaultPath(writer, path);
  await ensureParentDirectories(writer, path);
  await withPathContext("write", path, async () => {
    if (isMarkdownPath(path)) {
      await writer.writeText(path, new TextDecoder().decode(bytes));
      return;
    }

    await writer.writeBinary(path, bytes);
  });
}

export async function writeVaultBinary(
  writer: Pick<
    SyncVaultWriter,
    "exists" | "mkdir" | "writeBinary" | "isProtectedVaultPath"
  >,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  assertWritableVaultPath(writer, path);
  await ensureParentDirectories(writer, path);
  await withPathContext("write", path, async () => {
    await writer.writeBinary(path, bytes);
  });
}

export async function writeVaultText(
  writer: Pick<
    SyncVaultWriter,
    "exists" | "mkdir" | "writeText" | "isProtectedVaultPath"
  >,
  path: string,
  content: string,
): Promise<void> {
  assertWritableVaultPath(writer, path);
  await ensureParentDirectories(writer, path);
  await withPathContext("write", path, async () => {
    await writer.writeText(path, content);
  });
}

export async function renameVaultPath(
  writer: Pick<
    SyncVaultWriter,
    "exists" | "mkdir" | "rename" | "isProtectedVaultPath"
  >,
  oldPath: string,
  newPath: string,
): Promise<void> {
  assertWritableVaultPath(writer, oldPath);
  assertWritableVaultPath(writer, newPath);
  await ensureParentDirectories(writer, newPath);
  await withPathContext("rename", `${oldPath}" -> "${newPath}`, async () => {
    await writer.rename(oldPath, newPath);
  });
}

export async function removeVaultPathIfExists(
  writer: Pick<SyncVaultWriter, "exists" | "remove" | "isProtectedVaultPath">,
  path: string | null | undefined,
): Promise<boolean> {
  if (path) {
    assertWritableVaultPath(writer, path);
  }
  if (!path || !(await writer.exists(path))) {
    return false;
  }

  await withPathContext("delete", path, async () => {
    await writer.remove(path);
  });
  return true;
}

function assertWritableVaultPath(
  writer: Pick<SyncVaultWriter, "isProtectedVaultPath">,
  path: string,
): void {
  if (isNeverSyncReservedPath(path) || writer.isProtectedVaultPath?.(path)) {
    throw new Error(`Refusing to modify reserved vault path: ${path}`);
  }
}

export async function ensureParentDirectories(
  writer: Pick<SyncVaultWriter, "exists" | "mkdir">,
  path: string,
): Promise<void> {
  const parts = path.split("/").slice(0, -1);
  let current = "";
  for (const part of parts) {
    if (!part) {
      continue;
    }

    current = current ? `${current}/${part}` : part;
    if (!(await writer.exists(current))) {
      const folder = current;
      await withPathContext("create folder", folder, async () => {
        await writer.mkdir(folder);
      });
    }
  }
}

function isMarkdownPath(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}
