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
    /**
     * The name the operation was creating. Usually `path`; for a rename it is
     * the destination, because `path` then reads `old" -> "new` for display.
     */
    readonly createdPath: string = path,
  ) {
    super(`${operation} failed for "${path}": ${describeCause(cause)}`);
    this.name = "VaultWriteError";
  }
}

/**
 * Characters Android will not accept in a file or folder name. Obsidian's
 * mobile adapter reports the refusal as a bare `FILE_NOTCREATED`.
 */
const ANDROID_FORBIDDEN_NAME_CHARACTERS = ['"', "*", ":", "<", ">", "?", "\\", "|"];

const ANDROID_NAME_REFUSED_CODE = "FILE_NOTCREATED";

/** The operations that bring a name into being, and so can be refused one. */
const NAME_CREATING_OPERATIONS = new Set(["write", "create folder", "rename"]);

export interface PlatformRefusedName {
  /** The file or folder that could not be created. */
  path: string;
  /** Which of its characters the platform does not allow, in a stable order. */
  characters: string[];
}

/**
 * Whether a vault write failed because this device does not allow a character
 * in the name, and if so which name and which characters.
 *
 * Only answers when both halves are visible - Android's refusal code and a
 * character Android refuses - so a FILE_NOTCREATED from a full disk or a
 * permission problem is never blamed on the name. Looks through `cause` too,
 * since callers may wrap the error on its way to the notice.
 */
export function platformRefusedName(error: unknown): PlatformRefusedName | null {
  const writeError = findVaultWriteError(error);
  if (
    !writeError ||
    !NAME_CREATING_OPERATIONS.has(writeError.operation) ||
    !causeMentions(writeError.cause, ANDROID_NAME_REFUSED_CODE)
  ) {
    return null;
  }

  const characters = ANDROID_FORBIDDEN_NAME_CHARACTERS.filter((character) =>
    writeError.createdPath.includes(character),
  );
  return characters.length > 0 ? { path: writeError.createdPath, characters } : null;
}

function findVaultWriteError(error: unknown): VaultWriteError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (current instanceof VaultWriteError) {
      return current;
    }
    current = current instanceof Error ? (current as { cause?: unknown }).cause : null;
  }
  return null;
}

// Read as fields rather than `instanceof Error`: a platform plugin's rejection
// is not always a real Error, but it carries `message` and `code` either way.
function causeMentions(cause: unknown, text: string): boolean {
  if (typeof cause === "string") {
    return cause.includes(text);
  }
  if (!cause || typeof cause !== "object") {
    return false;
  }
  const { message, code } = cause as { message?: unknown; code?: unknown };
  return (
    (typeof message === "string" && message.includes(text)) ||
    (typeof code === "string" && code.includes(text))
  );
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
  createdPath: string = path,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw error instanceof VaultWriteError
      ? error
      : new VaultWriteError(operation, path, error, createdPath);
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
  await withPathContext(
    "rename",
    `${oldPath}" -> "${newPath}`,
    async () => {
      await writer.rename(oldPath, newPath);
    },
    newPath,
  );
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
