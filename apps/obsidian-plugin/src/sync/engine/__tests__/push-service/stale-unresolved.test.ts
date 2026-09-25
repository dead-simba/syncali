import { describe, expect, it } from "vitest";

import { SyncRealtimeError, SYNC_FEATURE_GET_ENTRY_STATES } from "../../../remote/realtime-client";
import {
  arrange,
  drain,
  ENTRY_ID,
  expectParkedWithEditKept,
  LOCAL_TEXT,
  MAX_UPLOADS,
  MERGED_TEXT,
  PATH,
  REMOTE_TEXT,
} from "./stale-harness";
import { encodeUtf8 } from "../../../core/content";
import { SyncEventRecorder } from "../../event-recorder";
import { encryptRemoteMetadata, TEST_VAULT_KEY } from "../pull-service/helpers";

/**
 * A change the server keeps rejecting as out of date must not be uploaded
 * forever.
 *
 * Measured on a desktop: one 13,258-byte note uploaded 837 times in 12.8
 * minutes, every upload accepted, no commit landing. Its queued change was
 * based on revision 1 and the server was ahead. A stale rejection is answered
 * by pulling and trying again, which works when the pull brings the newer
 * revision down - and does nothing at all when it cannot. Three ways it
 * cannot, each reproduced here:
 *
 *   (a) the newer revision's metadata will not decrypt, so the pull drops it;
 *   (b) its path is excluded on this device, so the pull records it but leaves
 *       the queued change's base alone;
 *   (c) the pull cursor is already past it, so the pull never sees it again.
 *
 * The bound these hold to: no more than four uploads of one change without it
 * landing, its base moving, or it being set aside with the edit kept.
 */

describe("a stale rejection a pull cannot fix", () => {
  it("(a) sets the change aside when the server's newer revision will not decrypt", async () => {
    const context = await arrange({
      features: [SYNC_FEATURE_GET_ENTRY_STATES],
      localCursor: 0,
      remote: { revision: 2, updatedSeq: 3, undecryptable: true },
    });

    await drain(context);

    expect(context.server.uploads.length).toBeLessThanOrEqual(MAX_UPLOADS);
    expect(context.server.uploads).toEqual(["blob-local", "blob-local"]);
    const event = await expectParkedWithEditKept(context, context.store);
    expect(event).toMatchObject({
      entryId: ENTRY_ID,
      serverRevision: 2,
      baseRevision: 1,
      outcome: { resolved: false, reason: "undecryptable", remoteRevision: 2 },
    });
    expect(context.quarantined[0]?.error).toHaveProperty(
      "message",
      "server revision 2, this device's base revision 1: set aside, the server's revision 2 could not be decrypted on this device",
    );
    expect(context.undecryptable).toHaveBeenCalled();
    await context.store.close();
  });

  it("(b) sets the change aside when the server's newer revision is at an excluded path", async () => {
    const context = await arrange({
      features: [SYNC_FEATURE_GET_ENTRY_STATES],
      localCursor: 0,
      remote: { revision: 2, updatedSeq: 3, path: "Private/The Lean Startup.md" },
      shouldApplyRemotePath: (path) => !path.startsWith("Private/"),
    });

    await drain(context);

    expect(context.server.uploads.length).toBeLessThanOrEqual(MAX_UPLOADS);
    const event = await expectParkedWithEditKept(context, context.store);
    expect(event.outcome).toEqual({
      resolved: false,
      reason: "excluded",
      remoteRevision: 2,
      remotePath: "Private/The Lean Startup.md",
    });
    // The excluded path is never written on this device.
    expect(context.adapter.bytes("Private/The Lean Startup.md")).toBeNull();
    await context.store.close();
  });

  it("(c) sets the change aside on a server that cannot fetch one entry, without asking it to", async () => {
    const context = await arrange({
      features: [],
      localCursor: 3,
      remote: { revision: 2, updatedSeq: 2 },
    });

    await drain(context);

    expect(context.server.uploads.length).toBeLessThanOrEqual(MAX_UPLOADS);
    expect(context.server.fetchedById).toEqual([]);
    // The pull never sees the entry: the cursor is already past it.
    expect(context.server.listedSince.every((since) => since === 3)).toBe(true);
    const event = await expectParkedWithEditKept(context, context.store);
    expect(event.outcome).toEqual({ resolved: false, reason: "fetch_unavailable" });
    await context.store.close();
  });

  it("stops at the cap when the server's revision keeps moving past a base that cannot", async () => {
    // Another device keeps writing the note while this one cannot bring any
    // of it down, so no two rejections carry the same pair of revisions.
    const context = await arrange({
      features: [SYNC_FEATURE_GET_ENTRY_STATES],
      localCursor: 0,
      remote: { revision: 2, updatedSeq: 3, path: "Private/The Lean Startup.md" },
      shouldApplyRemotePath: (path) => !path.startsWith("Private/"),
    });
    context.server.bumpRevisionOnReject = async () => {
      const current = context.server.entries.get(ENTRY_ID);
      if (!current) {
        return;
      }
      const revision = current.revision + 1;
      context.server.put(
        {
          ...current,
          revision,
          encryptedMetadata: await encryptRemoteMetadata({
            entryId: ENTRY_ID,
            revision,
            blobId: "blob-remote",
            path: "Private/The Lean Startup.md",
            hash: context.remoteHash,
          }),
        },
        context.server.cursor + 1,
      );
    };

    await drain(context);

    expect(context.server.uploads).toHaveLength(MAX_UPLOADS);
    const event = await expectParkedWithEditKept(context, context.store);
    expect(event.outcome).toEqual({ resolved: false, reason: "repeated" });
    await context.store.close();
  });

  it("leaves a set-aside stale change alone on reconnect, and retries it when asked", async () => {
    const context = await arrange({
      features: [],
      localCursor: 3,
      remote: { revision: 2, updatedSeq: 2 },
    });
    await drain(context);
    expect((await context.store.getDirtyEntryMutation(ENTRY_ID))?.status).toBe("blocked");

    // A new session changes nothing about why it was parked. Un-parking it
    // here is how the loop came back in episodes, one per reconnect.
    await expect(context.pushService.retryQuarantinedMutations()).resolves.toBe(0);
    expect((await context.store.getDirtyEntryMutation(ENTRY_ID))?.status).toBe("blocked");

    // "Try these again" is the user saying something may have changed.
    await expect(context.pushService.retryParkedMutations()).resolves.toBe(1);
    expect(await context.store.listDirtyEntries()).toMatchObject([
      { mutationId: "mutation-stuck", baseRevision: 1 },
    ]);
    await context.store.close();
  });
});

describe("a stale rejection the server can settle by id", () => {
  it("(c) fetches the entry the cursor passed, merges the edit, and lands it", async () => {
    const context = await arrange({
      features: [SYNC_FEATURE_GET_ENTRY_STATES],
      localCursor: 3,
      remote: { revision: 2, updatedSeq: 2 },
    });

    await drain(context);

    expect(context.server.uploads.length).toBeLessThanOrEqual(MAX_UPLOADS);
    expect(context.server.fetchedById).toEqual([[ENTRY_ID]]);
    // Rejected twice from base 1, then accepted from the merged base 2.
    expect(context.server.commitBases).toEqual([1, 1, 2]);
    expect(context.server.entries.get(ENTRY_ID)?.revision).toBe(3);
    expect(context.adapter.text(PATH)).toBe(MERGED_TEXT);
    expect(await context.store.getDirtyEntryMutation(ENTRY_ID)).toBeNull();
    expect(context.quarantined).toEqual([]);
    expect(context.recovered).toEqual([
      {
        entryId: ENTRY_ID,
        mutationId: "mutation-stuck",
        op: "upsert",
        serverRevision: 2,
        baseRevision: 1,
        outcome: { resolved: true, how: "merged" },
      },
    ]);
    // Fetching by id never read the change feed out of order: every pull
    // started from the cursor this device already had.
    expect(context.server.listedSince.every((since) => since === 3)).toBe(true);
    expect(await context.store.getCursor()).toBe(context.server.cursor);
    await context.store.close();
  });

  it("does not move the pull cursor when it applies an entry by id", async () => {
    const context = await arrange({
      features: [SYNC_FEATURE_GET_ENTRY_STATES],
      localCursor: 3,
      remote: { revision: 2, updatedSeq: 2 },
    });
    context.server.cursor = 40;

    const applied = await context.pullService.applyEntryStatesById(
      context.server.session(),
      [ENTRY_ID, "entry-the-server-never-had"],
    );

    expect(applied.entries.get(ENTRY_ID)).toEqual({
      status: "applied",
      revision: 2,
      path: PATH,
      deleted: false,
    });
    expect(applied.entries.get("entry-the-server-never-had")).toEqual({ status: "missing" });
    expect(await context.store.getCursor()).toBe(3);
    expect((await context.store.getRemoteStateById(ENTRY_ID))?.revision).toBe(2);
    await context.store.close();
  });
});

describe("a stale rejection while the note is being edited", () => {
  it("still recovers when every pass carries a new change from the same base", async () => {
    // Obsidian autosaves about every two seconds, faster than the backoff, so
    // on a note someone is working in, each rejection comes from a new queued
    // change. The pair of revisions is what shows the pull did not help, not
    // which change carried it.
    const context = await arrange({
      features: [SYNC_FEATURE_GET_ENTRY_STATES],
      localCursor: 3,
      remote: { revision: 2, updatedSeq: 2 },
    });

    await drain(context, 20, async (pass) => {
      const current = await context.store.getDirtyEntryMutation(ENTRY_ID);
      if (current && current.status !== "blocked") {
        await context.store.replaceDirtyEntry({
          ...current,
          mutationId: `mutation-edit-${pass}`,
        });
      }
    });

    expect(context.server.fetchedById).toEqual([[ENTRY_ID]]);
    expect(context.server.uploads.length).toBeLessThanOrEqual(MAX_UPLOADS);
    expect(context.server.entries.get(ENTRY_ID)?.revision).toBe(3);
    expect(context.adapter.text(PATH)).toBe(MERGED_TEXT);
    expect(context.quarantined).toEqual([]);
    expect(context.recovered).toMatchObject([
      { serverRevision: 2, baseRevision: 1, outcome: { resolved: true, how: "merged" } },
    ]);
    await context.store.close();
  });
});

describe("a server error while fetching the entry by id", () => {
  async function pushUntilSettled(context: Awaited<ReturnType<typeof arrange>>) {
    const session = context.server.session();
    for (let pass = 0; pass < 20; pass += 1) {
      try {
        const pushed = await context.pushService.pushPendingMutations(session);
        if (pushed.shouldPullAfterPush) {
          await context.pullService.pullOnce(session);
        }
        if (!pushed.hasMore) {
          return;
        }
      } catch {
        // The auto-sync backoff would run here.
      }
    }
  }

  it("retries a one-off failure instead of setting the note aside", async () => {
    // A reconnect never un-parks a stale change, so parking it over a server
    // hiccup would leave it stuck until someone noticed.
    const context = await arrange({
      features: [SYNC_FEATURE_GET_ENTRY_STATES],
      localCursor: 3,
      remote: { revision: 2, updatedSeq: 2 },
    });
    context.server.failEntryStatesById = new SyncRealtimeError(
      "entry_states_by_id_failed",
      "unexpected server error",
    );
    context.server.failEntryStatesByIdTimes = 1;

    await pushUntilSettled(context);

    expect(context.quarantined).toEqual([]);
    expect(context.server.entries.get(ENTRY_ID)?.revision).toBe(3);
    expect(context.adapter.text(PATH)).toBe(MERGED_TEXT);
    expect(context.server.uploads.length).toBeLessThanOrEqual(MAX_UPLOADS);
    await context.store.close();
  });

  it("sets the note aside at the cap when the server keeps failing", async () => {
    const context = await arrange({
      features: [SYNC_FEATURE_GET_ENTRY_STATES],
      localCursor: 3,
      remote: { revision: 2, updatedSeq: 2 },
    });
    context.server.failEntryStatesById = new SyncRealtimeError(
      "entry_states_by_id_failed",
      "unexpected server error",
    );

    await pushUntilSettled(context);

    expect(context.server.uploads).toHaveLength(MAX_UPLOADS);
    const event = await expectParkedWithEditKept(context, context.store);
    expect(event.outcome).toEqual({ resolved: false, reason: "repeated" });
    await context.store.close();
  });

  it("sets the note aside at once when the server refuses the request itself", async () => {
    const context = await arrange({
      features: [SYNC_FEATURE_GET_ENTRY_STATES],
      localCursor: 3,
      remote: { revision: 2, updatedSeq: 2 },
    });
    context.server.failEntryStatesById = new SyncRealtimeError(
      "invalid_message",
      "entryIds must contain 1 to 100 ids",
    );

    await pushUntilSettled(context);

    expect(context.server.uploads).toHaveLength(2);
    const event = await expectParkedWithEditKept(context, context.store);
    expect(event.outcome).toEqual({
      resolved: false,
      reason: "fetch_failed",
      detail: "entryIds must contain 1 to 100 ids",
    });
    await context.store.close();
  });
});

describe("what recovery records about how it ended", () => {
  it("says a local delete was undone, not that the server already had it", async () => {
    // The pull's pending-change handling cannot merge a delete into an edit,
    // so it keeps the server's version and drops the delete. The line in
    // Recent problems is how the cause is read off a device afterwards, so it
    // has to say that.
    const context = await arrange({
      features: [SYNC_FEATURE_GET_ENTRY_STATES],
      localCursor: 3,
      remote: { revision: 2, updatedSeq: 2 },
      pendingOp: "delete",
    });

    await drain(context);

    expect(context.adapter.text(PATH)).toBe(REMOTE_TEXT);
    expect(await context.store.getDirtyEntryMutation(ENTRY_ID)).toBeNull();
    expect(context.recovered).toMatchObject([
      { outcome: { resolved: true, how: "delete_undone" } },
    ]);
    await context.store.close();
  });
});

describe("what recovery records about a delete the server also has", () => {
  it("says the server already had it, not that the delete was undone", async () => {
    // Another device moved the note and then deleted it. Nothing is restored
    // here - the file stays deleted and so does the server's entry - so the
    // line in Recent problems must not say the server's version came back.
    const context = await arrange({
      features: [SYNC_FEATURE_GET_ENTRY_STATES],
      localCursor: 3,
      remote: { revision: 2, updatedSeq: 2 },
      pendingOp: "delete",
    });
    context.server.put(
      {
        entryId: ENTRY_ID,
        revision: 2,
        blobId: null,
        encryptedMetadata: await encryptRemoteMetadata({
          entryId: ENTRY_ID,
          revision: 2,
          deleted: true,
          blobId: null,
          path: "Archive/The Lean Startup.md",
        }),
        deleted: true,
      },
      2,
    );

    await drain(context);

    expect(context.adapter.bytes(PATH)).toBeNull();
    expect(context.server.entries.get(ENTRY_ID)?.deleted).toBe(true);
    expect(context.recovered).toMatchObject([
      { outcome: { resolved: true, how: "already_on_server" } },
    ]);
    await context.store.close();
  });
});

describe("a stale delete", () => {
  it("is set aside with its op, and comes back when asked", async () => {
    const context = await arrange({
      features: [],
      localCursor: 3,
      remote: { revision: 2, updatedSeq: 2 },
      pendingOp: "delete",
    });

    await drain(context);

    expect(context.server.uploads).toEqual([]);
    expect(context.server.commitBases).toEqual([1, 1]);
    expect(await context.store.getDirtyEntryMutation(ENTRY_ID)).toMatchObject({
      op: "delete",
      status: "blocked",
      blockedReason: "stale_unresolved",
    });
    expect(context.quarantined[0]?.error).toMatchObject({
      event: { op: "delete", outcome: { resolved: false, reason: "fetch_unavailable" } },
    });
    await expect(context.pushService.retryQuarantinedMutations()).resolves.toBe(0);
    await expect(context.pushService.retryParkedMutations()).resolves.toBe(1);
    await context.store.close();
  });
});

describe("recovery and a path this device does not sync", () => {
  it("leaves the recorded remote state alone, so the next edit cannot overwrite it", async () => {
    // Case (c) with the server's copy moved to an excluded folder. Recording
    // the server's revision here, as a pull that saw it would, makes the next
    // edit build on that revision - and the server accepts it, replacing the
    // other device's version with this one's, at the old path, with no merge
    // and no conflict copy. Recovery must not open that path.
    const context = await arrange({
      features: [SYNC_FEATURE_GET_ENTRY_STATES],
      localCursor: 3,
      remote: { revision: 2, updatedSeq: 2, path: "Private/The Lean Startup.md" },
      shouldApplyRemotePath: (path) => !path.startsWith("Private/"),
    });

    await drain(context);

    const event = await expectParkedWithEditKept(context, context.store);
    expect(event.outcome).toMatchObject({
      resolved: false,
      reason: "excluded",
      remotePath: "Private/The Lean Startup.md",
    });
    expect((await context.store.getRemoteStateById(ENTRY_ID))?.revision).toBe(1);
    await context.store.close();
  });
});

/** Obsidian saving the note: the file changes, and the change is queued. */
async function saveNote(context: Awaited<ReturnType<typeof arrange>>, text: string) {
  await context.adapter.writeText(PATH, text);
  const recorder = new SyncEventRecorder({
    getSyncStore: () => context.store,
    getRemoteVaultKey: () => TEST_VAULT_KEY,
  });
  await recorder.recordUpsert(PATH, encodeUtf8(text));
}

describe("editing a note that was set aside as stale", () => {
  it("keeps each new edit set aside without uploading, fetching or notifying again", async () => {
    // Every autosave queues a new change on the same base, which the server
    // rejects with the same pair of revisions. Forgetting the pair when the
    // change was parked made each one start over: two uploads, a fetch by id
    // and a new notice per autosave, for as long as the note was being typed
    // in - the loop the parking was there to stop.
    const context = await arrange({
      features: [SYNC_FEATURE_GET_ENTRY_STATES],
      localCursor: 0,
      remote: { revision: 2, updatedSeq: 3, undecryptable: true },
    });
    await drain(context);
    await expectParkedWithEditKept(context, context.store);
    expect(context.server.uploads).toHaveLength(2);

    for (let save = 0; save < 10; save += 1) {
      await saveNote(context, `${LOCAL_TEXT}\nsave ${save}\n`);
      await drain(context);
    }

    expect(context.server.uploads).toHaveLength(2);
    expect(context.server.fetchedById).toHaveLength(1);
    expect(context.quarantined).toHaveLength(1);
    const latest = await context.store.getDirtyEntryMutation(ENTRY_ID);
    expect(latest).toMatchObject({
      baseRevision: 1,
      status: "blocked",
      blockedReason: "stale_unresolved",
    });
    expect(latest?.mutationId).not.toBe("mutation-stuck");
    expect(context.adapter.text(PATH)).toBe(`${LOCAL_TEXT}\nsave 9\n`);

    // Try these again is still the way back, and it tries in earnest.
    await expect(context.pushService.retryParkedMutations()).resolves.toBe(1);
    await drain(context);
    expect(context.server.uploads.length).toBeGreaterThan(2);
    await context.store.close();
  });

  it("does not let an edit build on a server revision at a path this device does not sync", async () => {
    // The ordinary pull that follows the first rejection sees the server's
    // revision at the excluded path. Recording it there made the next edit
    // build on it, and the server accepted that edit: the other device's
    // version and its move replaced by this one's, with no merge and no
    // conflict copy.
    const context = await arrange({
      features: [SYNC_FEATURE_GET_ENTRY_STATES],
      localCursor: 0,
      remote: { revision: 2, updatedSeq: 3, path: "Private/The Lean Startup.md" },
      shouldApplyRemotePath: (path) => !path.startsWith("Private/"),
    });
    await drain(context);
    await expectParkedWithEditKept(context, context.store);

    await saveNote(context, `${LOCAL_TEXT}\nedited after it was set aside\n`);
    await drain(context);

    expect(context.server.entries.get(ENTRY_ID)).toMatchObject({
      revision: 2,
      blobId: "blob-remote",
    });
    expect(context.server.commitBases.every((base) => base === 1)).toBe(true);
    expect(await context.store.getDirtyEntryMutation(ENTRY_ID)).toMatchObject({
      baseRevision: 1,
      status: "blocked",
      blockedReason: "stale_unresolved",
    });
    await context.store.close();
  });
});
