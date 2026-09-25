import { describe, expect, it } from "vitest";

import { ApiRequestError } from "../../../../http/request";
import { encodeUtf8, hashBytes } from "../../../core/content";
import {
  arrangePendingUpsertWithCachedBase,
  encryptRemoteMetadata,
} from "../pull-service/helpers";
import { arrange, ENTRY_ID, PATH, type StaleContext } from "./stale-harness";

/**
 * An upload that fails the same retryable way every time must not hold the
 * rest of the vault back, and must not be retried forever.
 *
 * Treating server errors as worth retrying fixed good notes being set aside
 * over a dropped connection or an overloaded Worker. But the retry rethrew
 * out of the whole batch, so one file whose upload kept failing - the API
 * answers anything unexpected with a 500 - stopped every other file from
 * committing, re-uploaded all of their blobs on every backoff step, and was
 * never set aside. Measured with two files: ten passes, ten throws, the
 * healthy file uploaded ten times and committed zero.
 */

const OTHER_ENTRY_ID = "entry-other";
const OTHER_PATH = "Notes/Other.md";
const OTHER_TEXT = "other note, edited\n";

async function arrangeTwoFiles(): Promise<StaleContext> {
  // Remote revision 1 matches the queued change's base, so nothing is stale:
  // the only thing wrong with the note is its upload.
  const context = await arrange({
    features: [],
    localCursor: 1,
    remote: { revision: 1, updatedSeq: 1 },
  });

  const baseText = "other note\n";
  const baseHash = await hashBytes(encodeUtf8(baseText));
  const localHash = await hashBytes(encodeUtf8(OTHER_TEXT));
  context.adapter.files.set(OTHER_PATH, encodeUtf8(OTHER_TEXT));
  await arrangePendingUpsertWithCachedBase(context.store, {
    entryId: OTHER_ENTRY_ID,
    path: OTHER_PATH,
    baseRevision: 1,
    baseBlobId: "blob-other-base",
    baseHash,
    baseBytes: encodeUtf8(baseText),
    localBlobId: "blob-other-local",
    localHash,
    // Queued after the failing note, so it is always behind it in the batch.
    createdAt: 5,
  });
  context.server.put(
    {
      entryId: OTHER_ENTRY_ID,
      revision: 1,
      blobId: "blob-other-base",
      encryptedMetadata: await encryptRemoteMetadata({
        entryId: OTHER_ENTRY_ID,
        revision: 1,
        blobId: "blob-other-base",
        path: OTHER_PATH,
        hash: baseHash,
      }),
      deleted: false,
    },
    1,
  );
  context.server.failUpload = (blobId) =>
    blobId === "blob-local"
      ? new ApiRequestError(500, "internal_error", "unexpected server error")
      : null;
  return context;
}

async function pushRepeatedly(context: StaleContext, passes: number) {
  const session = context.server.session();
  const retried: unknown[] = [];
  for (let pass = 0; pass < passes; pass += 1) {
    const pushed = await context.pushService.pushPendingMutations(session);
    if (pushed.retryLater) {
      retried.push(pushed.retryLater.error);
    }
    if (!pushed.hasMore) {
      break;
    }
  }
  return retried;
}

describe("an upload that keeps failing in a retryable way", () => {
  it("lets the rest of the batch commit on the first pass", async () => {
    const context = await arrangeTwoFiles();

    const pushed = await context.pushService.pushPendingMutations(context.server.session());

    // The failure still surfaces, so the auto-sync backoff runs and the error
    // is reported.
    expect(pushed).toMatchObject({ mutationsPushed: 1, mutationsRequeued: 1, hasMore: true });
    expect(pushed.retryLater?.error).toBeInstanceOf(ApiRequestError);

    expect(context.server.entries.get(OTHER_ENTRY_ID)?.revision).toBe(2);
    expect(await context.store.getDirtyEntryMutation(OTHER_ENTRY_ID)).toBeNull();
    // The failing note is waiting for the next attempt, not set aside.
    const waiting = await context.store.getDirtyEntryMutation(ENTRY_ID);
    expect(waiting).not.toBeNull();
    expect(waiting?.status).not.toBe("blocked");
    expect(context.quarantined).toEqual([]);
    await context.store.close();
  });

  it("sets the failing file aside after a bounded number of attempts", async () => {
    const context = await arrangeTwoFiles();

    const retried = await pushRepeatedly(context, 20);

    const failingUploads = context.server.uploads.filter((blobId) => blobId === "blob-local");
    expect(failingUploads).toHaveLength(5);
    expect(context.server.uploads.filter((blobId) => blobId === "blob-other-local")).toHaveLength(
      1,
    );
    expect(retried).toHaveLength(4);
    expect(await context.store.getDirtyEntryMutation(ENTRY_ID)).toMatchObject({
      status: "blocked",
      blockedReason: "prepare_failed",
    });
    expect(context.quarantined).toHaveLength(1);
    expect(context.quarantined[0]?.error).toBeInstanceOf(ApiRequestError);

    // Set aside as prepare_failed, so a new session gives it another chance -
    // an outage that has ended should not need the user to notice.
    await expect(context.pushService.retryQuarantinedMutations()).resolves.toBe(1);
    await context.store.close();
  });

  it("gives it one attempt per reconnect once it has used up its retries", async () => {
    // Every new session un-parks it. With a fresh count each time, a server
    // that kept failing the upload cost five uploads and a notice per
    // reconnect - the episodes the retries were added to end, five times over.
    const context = await arrangeTwoFiles();
    await pushRepeatedly(context, 20);
    const failingUploads = () =>
      context.server.uploads.filter((blobId) => blobId === "blob-local").length;
    expect(failingUploads()).toBe(5);

    for (let reconnect = 0; reconnect < 3; reconnect += 1) {
      await expect(context.pushService.retryQuarantinedMutations()).resolves.toBe(1);
      await pushRepeatedly(context, 20);
    }

    expect(failingUploads()).toBe(8);
    expect(await context.store.getDirtyEntryMutation(ENTRY_ID)).toMatchObject({
      status: "blocked",
      blockedReason: "prepare_failed",
    });

    // That one attempt is a real one: once the server recovers, it lands.
    context.server.failUpload = null;
    await context.pushService.retryQuarantinedMutations();
    await pushRepeatedly(context, 20);
    expect(context.server.entries.get(ENTRY_ID)?.revision).toBe(2);

    await context.store.close();
  });

  it("gives it the full count again when the user asks", async () => {
    const context = await arrangeTwoFiles();
    await pushRepeatedly(context, 20);

    await expect(context.pushService.retryParkedMutations()).resolves.toBe(1);
    await pushRepeatedly(context, 20);

    expect(context.server.uploads.filter((blobId) => blobId === "blob-local")).toHaveLength(10);
    await context.store.close();
  });

  it("starts the count again once the upload succeeds", async () => {
    const context = await arrangeTwoFiles();
    let failures = 0;
    // Four failures, one success: a bad minute, not a bad file.
    context.server.failUpload = (blobId) =>
      blobId === "blob-local" && (failures += 1) <= 4
        ? new ApiRequestError(503, "http_503", "error code: 1102")
        : null;

    await pushRepeatedly(context, 20);

    expect(context.quarantined).toEqual([]);
    expect(context.server.entries.get(ENTRY_ID)?.revision).toBe(2);
    await context.store.close();
  });
});

describe("a file this device cannot read", () => {
  it("is set aside even when its path reads like a network failure", async () => {
    // The error names the file, and "Offline maps" matched the offline
    // markers. That rethrew out of every push, with no count and no parking:
    // one unreadable file stopped the whole vault syncing.
    const context = await arrange({
      features: [],
      localCursor: 1,
      remote: { revision: 1, updatedSeq: 1 },
    });
    const readBytes = context.adapter.readBytes.bind(context.adapter);
    context.adapter.readBytes = async (path: string) => {
      if (path === PATH) {
        throw Object.assign(
          new Error("EACCES: permission denied, open '/vault/Offline maps/Trip.md'"),
          { code: "EACCES" },
        );
      }
      return await readBytes(path);
    };

    await expect(pushRepeatedly(context, 20)).resolves.toBeDefined();

    expect(await context.store.getDirtyEntryMutation(ENTRY_ID)).toMatchObject({
      status: "blocked",
      blockedReason: "prepare_failed",
    });
    expect(context.quarantined).toHaveLength(1);
    await context.store.close();
  });
});
