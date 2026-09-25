import { describe, expect, it } from "vitest";

import { ApiRequestError } from "./request";
import { isOfflineLikeError, isTransientSyncError } from "./network-status";

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

describe("transient sync error detection", () => {
  // Word for word from a desktop's Recent problems, each one the reason a good
  // note was set aside - and un-set-aside by the next reconnect, and uploaded
  // again, which is how the upload loop came back in episodes.
  it.each([
    "net::ERR_CONNECTION_RESET",
    "net::ERR_NETWORK_CHANGED",
    "net::ERR_NETWORK_IO_SUSPENDED",
    "sync token expired",
    "unexpected server error",
  ])("retries %s instead of blaming the file", (message) => {
    expect(isTransientSyncError(new Error(message), online)).toBe(true);
  });

  it.each([
    "net::ERR_NAME_NOT_RESOLVED",
    "net::ERR_QUIC_PROTOCOL_ERROR",
    "net::ERR_INTERNET_DISCONNECTED",
    "net::ERR_TIMED_OUT",
  ])("recognizes Chromium's %s as a network failure", (message) => {
    expect(isTransientSyncError(new Error(message), online)).toBe(true);
  });

  it("retries an overloaded Worker, whether it reports the status or only the text", () => {
    // "error code: 1102 (http_503)" is how this one reached the user.
    expect(
      isTransientSyncError(new ApiRequestError(503, "http_503", "error code: 1102"), online),
    ).toBe(true);
    expect(isTransientSyncError(new Error("error code: 1102"), online)).toBe(true);
    expect(isTransientSyncError({ code: "http_503", message: "" }, online)).toBe(true);
    expect(isTransientSyncError(new Error("Service Unavailable"), online)).toBe(true);
  });

  it("retries rate limiting", () => {
    expect(isTransientSyncError(new ApiRequestError(429, "http_429", "slow down"), online)).toBe(
      true,
    );
    expect(isTransientSyncError(new Error("Too Many Requests"), online)).toBe(true);
  });

  it("still covers everything that counts as offline", () => {
    expect(isTransientSyncError(new Error("Connection reset by peer"), online)).toBe(true);
    expect(isTransientSyncError(new Error("anything"), () => true)).toBe(true);
  });

  it("does not excuse a file that will fail the same way again", () => {
    expect(
      isTransientSyncError(new Error('write failed for "note.md": FILE_NOTCREATED'), online),
    ).toBe(false);
    expect(
      isTransientSyncError(new Error("Upsert mutation m metadata hash does not match."), online),
    ).toBe(false);
    expect(isTransientSyncError(new ApiRequestError(413, "quota_exceeded", "full"), online)).toBe(
      false,
    );
  });

  it("does not excuse every Cloudflare error code, only the ones that pass", () => {
    // 1020 is a firewall rule blocking the request; it will block the next
    // one too. 1101 arrives with a 500 status in practice, which is what
    // makes that one retryable - the text alone does not.
    expect(isTransientSyncError(new Error("error code: 1020"), online)).toBe(false);
    expect(isTransientSyncError(new Error("error code: 1101"), online)).toBe(false);
    expect(isTransientSyncError(new Error("error code: 1015"), online)).toBe(true);
  });

  it("leaves the offline check alone, so an overloaded server is not shown as offline", () => {
    expect(isOfflineLikeError(new Error("error code: 1102"), online)).toBe(false);
    expect(isOfflineLikeError(new Error("unexpected server error"), online)).toBe(false);
    expect(isOfflineLikeError(new Error("sync token expired"), online)).toBe(false);
  });
});

describe("local file errors", () => {
  function fileError(code: string, message: string) {
    return Object.assign(new Error(`${code}: ${message}`), { code });
  }

  it.each([
    fileError("EACCES", "permission denied, open '/vault/Offline maps/Trip.md'"),
    fileError("EACCES", "permission denied, open '/vault/Internet Archive/scan.pdf'"),
    fileError("EISDIR", "illegal operation on a directory, read '/vault/Notes/Why the build timed out.md'"),
    fileError("EPERM", "operation not permitted, open '/vault/Work/Rate limit design.md'"),
  ])("are judged by their code, not by words in the file's path: %s", (error) => {
    // The path is the user's own words. Matched as text, a note under
    // "Offline maps/" read as a dropped connection and was retried forever.
    expect(isOfflineLikeError(error, online)).toBe(false);
    expect(isTransientSyncError(error, online)).toBe(false);
  });

  it("still reports offline when the device says it is offline", () => {
    const error = fileError("EACCES", "permission denied, open '/vault/Notes/a.md'");
    expect(isOfflineLikeError(error, () => true)).toBe(true);
  });
});
