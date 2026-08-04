import { describe, expect, it } from "vitest";

import { isOfflineLikeError } from "./network-status";

const online = () => false;

describe("offline-like error detection", () => {
  it("treats Android socket teardown as a connectivity blip", () => {
    // java.net.SocketException, raised when the OS kills a long-running
    // transfer (backgrounding, doze, Wi-Fi handover, memory pressure). Same
    // class as ECONNRESET, but worded by Android's network stack.
    expect(
      isOfflineLikeError(
        new Error("java.net.SocketException: Software caused connection abort"),
        online,
      ),
    ).toBe(true);
  });

  it.each([
    "Connection reset by peer",
    "Connection closed by peer",
    "Socket closed",
    "Broken pipe",
    "connect ETIMEDOUT 10.0.0.1:443",
    "Unable to resolve host \"api.example.com\": No address associated with hostname",
    "Network is unreachable",
  ])("recognizes %s as a transport failure", (message) => {
    expect(isOfflineLikeError(new Error(message), online)).toBe(true);
  });

  it("still surfaces genuine sync failures", () => {
    expect(
      isOfflineLikeError(new Error('write failed for "note.md": FILE_NOTCREATED'), online),
    ).toBe(false);
    expect(isOfflineLikeError(new Error("quota_exceeded"), online)).toBe(false);
    expect(isOfflineLikeError(new Error("hash does not match metadata"), online)).toBe(
      false,
    );
  });

  it("reports offline whenever the device says it is offline", () => {
    expect(isOfflineLikeError(new Error("anything"), () => true)).toBe(true);
  });
});
