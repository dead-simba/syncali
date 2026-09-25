import { describe, expect, it } from "vitest";

import { SyncRealtimeError } from "../../realtime-client";
import { openRealtimeSession, waitForSentMessage } from "./helpers";

/**
 * Fetching single entries is a server feature, so it is only ever used when
 * the server said it has it. An old server answers an unknown message type
 * with a session error that has no requestId, which fails every request in
 * flight on the socket - a pull or a commit that had nothing to do with it.
 */
describe("SyncRealtimeClient entry states by id", () => {
  it("treats a hello without features as a server with none", async () => {
    const { socket, session } = await openRealtimeSession();

    expect(session.features).toEqual([]);
    await expect(session.getEntryStatesById(["entry-1"])).rejects.toMatchObject({
      code: "feature_unavailable",
    });
    // Nothing but the hello went over the wire.
    expect(socket.sent).toHaveLength(1);
  });

  it("ignores a features field that is not a list of strings", async () => {
    const { session } = await openRealtimeSession({ helloFeatures: "get_entry_states" });

    expect(session.features).toEqual([]);
  });

  it("fetches entries by id when the server advertises it", async () => {
    const { socket, session } = await openRealtimeSession({
      helloFeatures: ["get_entry_states"],
    });

    const statesPromise = session.getEntryStatesById(["entry-1", "entry-2", "entry-1"]);
    await waitForSentMessage(socket, 1);
    const request = socket.sentMessageAt(1);
    expect(request).toEqual({
      type: "get_entry_states",
      requestId: request.requestId,
      entryIds: ["entry-1", "entry-2"],
    });
    socket.emitMessage({
      type: "entry_states_by_id",
      requestId: request.requestId,
      entries: [
        {
          entryId: "entry-1",
          revision: 7,
          blobId: "blob-7",
          encryptedMetadata: "metadata",
          deleted: false,
          updatedSeq: 9513,
          updatedAt: 12,
        },
      ],
    });

    await expect(statesPromise).resolves.toEqual([
      {
        entryId: "entry-1",
        revision: 7,
        blobId: "blob-7",
        encryptedMetadata: "metadata",
        deleted: false,
        updatedSeq: 9513,
        updatedAt: 12,
      },
    ]);
  });

  it("rejects with the server's code when the fetch fails", async () => {
    const { socket, session } = await openRealtimeSession({
      helloFeatures: ["get_entry_states"],
    });

    const statesPromise = session.getEntryStatesById(["entry-1"]);
    await waitForSentMessage(socket, 1);
    const request = socket.sentMessageAt(1);
    socket.emitMessage({
      type: "entry_states_by_id_failed",
      requestId: request.requestId,
      code: "invalid_message",
      message: "too many entry ids",
    });

    const error = await statesPromise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SyncRealtimeError);
    expect(error).toMatchObject({ code: "invalid_message", message: "too many entry ids" });
  });

  it("refuses an empty or oversized request before sending it", async () => {
    const { socket, session } = await openRealtimeSession({
      helloFeatures: ["get_entry_states"],
    });

    await expect(session.getEntryStatesById([])).rejects.toThrow("1 to 100");
    await expect(session.getEntryStatesById([""])).rejects.toThrow("1 to 100");
    await expect(
      session.getEntryStatesById(Array.from({ length: 101 }, (_, index) => `entry-${index}`)),
    ).rejects.toThrow("1 to 100");
    expect(socket.sent).toHaveLength(1);
  });
});
