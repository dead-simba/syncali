import { describe, expect, it } from "vitest";

import {
  encodeUtf8,
  hashBytes,
  parseSyncedEntryMetadata,
  serializeSyncedEntryMetadata,
} from "./content";

describe("hashBytes", () => {
  it("returns SHA-256 hex digests", async () => {
    await expect(hashBytes(encodeUtf8("abc"))).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("paths that begin or end with a space", () => {
  it("round-trips the name exactly, without trimming it", () => {
    // "V2.2 Ground Floor " is a real file on macOS. Trimming the path while
    // parsing metadata pointed every read and write at a name that does not
    // exist, and sync stopped with ENOENT.
    const path = "My Knowledge Base/Utilities/Images/V2.2 Ground Floor ";
    const serialized = serializeSyncedEntryMetadata({ path, hash: "hash-1" });

    expect(parseSyncedEntryMetadata(serialized).path).toBe(path);
  });

  it("still rejects a path that is only whitespace", () => {
    expect(() =>
      parseSyncedEntryMetadata(serializeSyncedEntryMetadata({ path: "   ", hash: null })),
    ).toThrow(/missing a file path/);
  });
});
