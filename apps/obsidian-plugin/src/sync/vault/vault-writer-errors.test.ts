import { describe, expect, it } from "vitest";

import {
  removeVaultPathIfExists,
  renameVaultPath,
  VaultWriteError,
  writeVaultBytes,
} from "./vault-writer";

function createWriter(overrides: Record<string, unknown> = {}) {
  return {
    exists: async () => true,
    mkdir: async () => {},
    writeText: async () => {},
    writeBinary: async () => {},
    rename: async () => {},
    remove: async () => {},
    ...overrides,
  } as never;
}

describe("vault write errors", () => {
  it("names the file when Obsidian mobile rejects the write", async () => {
    // Android reports an unwritable filename as a bare platform code with no
    // indication of which file it was.
    const writer = createWriter({
      writeText: async () => {
        throw new Error("FILE_NOTCREATED");
      },
    });

    await expect(
      writeVaultBytes(writer, "Notes/Why Planning is Important?.md", new Uint8Array()),
    ).rejects.toThrow(
      'write failed for "Notes/Why Planning is Important?.md": FILE_NOTCREATED',
    );
  });

  it("still names the file when the platform throws with no message", async () => {
    const writer = createWriter({
      writeBinary: async () => {
        throw new Error(undefined);
      },
    });

    await expect(
      writeVaultBytes(writer, "Attachments/scan.png", new Uint8Array()),
    ).rejects.toThrow('write failed for "Attachments/scan.png": Error');
  });

  it("reports the folder that could not be created", async () => {
    const writer = createWriter({
      exists: async () => false,
      mkdir: async () => {
        throw new Error("FILE_NOTCREATED");
      },
    });

    await expect(
      writeVaultBytes(writer, "Bad?Folder/note.md", new Uint8Array()),
    ).rejects.toThrow('create folder failed for "Bad?Folder": FILE_NOTCREATED');
  });

  it("reports both paths for a failed rename", async () => {
    const writer = createWriter({
      rename: async () => {
        throw new Error("FILE_NOTCREATED");
      },
    });

    await expect(renameVaultPath(writer, "a.md", "b?.md")).rejects.toThrow(
      'rename failed for "a.md" -> "b?.md": FILE_NOTCREATED',
    );
  });

  it("exposes the path and cause for callers that inspect the error", async () => {
    const cause = new Error("FILE_NOTCREATED");
    const writer = createWriter({
      remove: async () => {
        throw cause;
      },
    });

    const error = await removeVaultPathIfExists(writer, "Notes/gone.md").catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(VaultWriteError);
    expect((error as VaultWriteError).path).toBe("Notes/gone.md");
    expect((error as VaultWriteError).operation).toBe("delete");
    expect((error as VaultWriteError).cause).toBe(cause);
  });

  it("does not double-wrap an already contextualized error", async () => {
    const writer = createWriter({
      writeText: async () => {
        throw new VaultWriteError("write", "inner.md", new Error("boom"));
      },
    });

    await expect(
      writeVaultBytes(writer, "outer.md", new Uint8Array()),
    ).rejects.toThrow('write failed for "inner.md": boom');
  });
});
