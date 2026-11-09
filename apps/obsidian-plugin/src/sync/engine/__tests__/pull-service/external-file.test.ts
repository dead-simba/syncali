import { describe, expect, it } from "vitest";

import { DEFAULT_SYNC_FILE_RULES } from "../../../core/file-rules";
import { DEFAULT_VAULT_CONFIG_SYNC_RULES } from "../../../core/vault-config-rules";
import { shouldApplyRemoteVaultPath } from "../../../core/vault-path-policy";
import { SyncPullService } from "../../pull-service";
import { createInitializedTestSyncStore, createTestPlugin } from "../../../../test-support/test-plugin";
import {
  createCommit,
  createPullClient,
  createRealtimeSession,
  createToken,
  createVaultAdapter,
  encryptRemoteMetadata,
  encryptTestBlob,
  hashText,
  ignoreProgress,
  TEST_VAULT_KEY,
} from "./helpers";

/**
 * A desktop uploaded a file Obsidian had open from outside the vault, under
 * Obsidian's "file:" path. On Android a ":" in a name fails with
 * FILE_NOTCREATED, the apply phase rolled the whole window back, and the
 * cursor never moved: every pull on the phone failed at that entry, and
 * nothing after it arrived.
 */
const EXTERNAL =
  "file:/Users/alitahir/Documents/Development/Claude Code/Understanding-Quran-Words/Understanding-Quran-Words/behind/2026-10-19-alhamdulillah.md";

async function arrangeCommit(cursor: number, entryId: string, path: string, body: string) {
  const blobId = `blob-${entryId}`;
  return {
    blob: [blobId, await encryptTestBlob(blobId, new TextEncoder().encode(body))] as const,
    commit: createCommit({
      cursor,
      entryId,
      revision: 1,
      blobId,
      encryptedMetadata: await encryptRemoteMetadata({
        entryId,
        revision: 1,
        blobId,
        path,
        hash: await hashText(body),
      }),
    }),
  };
}

function createAndroidVaultAdapter() {
  const adapter = createVaultAdapter();
  const rejectColon = (path: string) => {
    if (path.includes(":")) {
      throw new Error("FILE_NOTCREATED");
    }
  };
  return {
    ...adapter,
    async mkdir(path: string): Promise<void> {
      rejectColon(path);
      await adapter.mkdir(path);
    },
    async writeText(path: string, content: string): Promise<void> {
      rejectColon(path);
      await adapter.writeText(path, content);
    },
    async writeBinary(path: string, content: Uint8Array): Promise<void> {
      rejectColon(path);
      await adapter.writeBinary(path, content);
    },
  };
}

describe("SyncPullService: a file from outside another device's vault", () => {
  it("is skipped, and everything after it still arrives", async () => {
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
    const adapter = createAndroidVaultAdapter();

    const before = await arrangeCommit(1, "entry-before", "+/Before.md", "before");
    const external = await arrangeCommit(2, "entry-external", EXTERNAL, "alhamdulillah");
    const sameWindow = await arrangeCommit(3, "entry-same", "+/Same window.md", "same window");
    const later = await arrangeCommit(4, "entry-later", "+/Later.md", "later");

    const service = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      getRemoteVaultKey: () => TEST_VAULT_KEY,
      shouldApplyRemotePath: (path) =>
        shouldApplyRemoteVaultPath(path, {
          fileRules: DEFAULT_SYNC_FILE_RULES,
          vaultConfigRules: DEFAULT_VAULT_CONFIG_SYNC_RULES,
        }),
      vaultAdapter: adapter,
      pullClient: createPullClient({
        blobs: Object.fromEntries(
          [before, external, sameWindow, later].map((arranged) => arranged.blob),
        ),
      }),
      onProgress: ignoreProgress,
    });

    await service.pullOnce(
      createRealtimeSession({
        pages: [
          { cursor: 1, hasMore: true, commits: [before.commit] },
          { cursor: 3, hasMore: true, commits: [external.commit, sameWindow.commit] },
          { cursor: 4, hasMore: false, commits: [later.commit] },
        ],
      }),
    );

    expect(await store.getCursor()).toBe(4);
    expect(adapter.text("+/Before.md")).toBe("before");
    expect(adapter.text("+/Same window.md")).toBe("same window");
    expect(adapter.text("+/Later.md")).toBe("later");
    expect(adapter.writes.some((path) => path.includes(":"))).toBe(false);
    // Recorded, not dropped: the server still holds it, and this device knows.
    expect(await store.getRemoteStateById("entry-external")).toMatchObject({
      revision: 1,
    });

    await store.close();
  });
});
