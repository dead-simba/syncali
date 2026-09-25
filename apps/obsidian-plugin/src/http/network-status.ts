export type OfflineDetector = () => boolean;

// Transport-layer drops that mean "the link went away", not "sync is broken".
// Matching one downgrades the failure to an offline status and a quiet retry
// instead of an alarming notice.
//
// The lower block is the same class of failure as ECONNRESET above, but worded
// by Android's Java network stack rather than reported as a POSIX code. Mobile
// surfaces these routinely when the OS tears down a long-running transfer -
// backgrounding, doze, a Wi-Fi/cellular handover, or memory pressure - which a
// large attachment download runs into far more often than a note sync does.
const OFFLINE_ERROR_MARKERS = [
  "offline",
  "failed to fetch",
  "networkerror",
  "network error",
  "network request failed",
  "load failed",
  "internet",
  "enotfound",
  "econnrefused",
  "econnreset",
  "etimedout",

  "connection abort",
  "econnaborted",
  "unexpected end of stream",
  "connection reset",
  "connection closed",
  "connection timed out",
  "socket closed",
  "software caused connection",
  "broken pipe",
  "epipe",
  "network is unreachable",
  "unable to resolve host",
  "no address associated with hostname",
];

export function isBrowserOffline(): boolean {
  return (
    typeof globalThis.navigator !== "undefined" &&
    globalThis.navigator.onLine === false
  );
}

export function isOffline(isOfflineOverride?: OfflineDetector): boolean {
  return isOfflineOverride?.() ?? isBrowserOffline();
}

export function isOfflineLikeError(
  error: unknown,
  isOfflineOverride?: OfflineDetector,
): boolean {
  if (isOffline(isOfflineOverride)) {
    return true;
  }
  if (isLocalFileError(error)) {
    return false;
  }

  const message = getErrorText(error).toLowerCase();
  return OFFLINE_ERROR_MARKERS.some((marker) => message.includes(marker));
}

// Failures that are worth retrying but are not "offline". Kept out of
// OFFLINE_ERROR_MARKERS on purpose: that list decides whether the status says
// offline, and an overloaded server answering "error code: 1102" is not the
// device being offline. These decide only whether a file is at fault.
//
// Chromium, and so Obsidian on desktop, words its network failures as
// "net::ERR_CONNECTION_RESET" rather than "connection reset", which the offline
// markers never matched - so a Wi-Fi handover or a laptop going to sleep parked
// perfectly good files. Every net::ERR_ is a network failure by definition.
const TRANSIENT_ERROR_MARKERS = [
  "net::err_",
  // The request client refreshes an expired token and tries once more. When
  // even that is refused the token is the problem, not the file.
  "token expired",
  "sync token",
  // Cloudflare's own error pages, named one by one because most of the 1xxx
  // range is not worth retrying: 1020 is a firewall rule and 1101 a Worker
  // that threw. 1102 is a Worker that ran out of CPU time, 1015 and 1200 are
  // Cloudflare shedding load.
  "error code: 1102",
  "error code: 1015",
  "error code: 1200",
  // The API's catch-all for anything it did not expect.
  "unexpected server error",
  "internal server error",
  "service unavailable",
  "bad gateway",
  "gateway timeout",
  "too many requests",
  "rate limit",
  "timed out",
];

const TRANSIENT_ERROR_CODE = /^(?:http_)?(?:5\d\d|429|408)$/;

/**
 * Whether a sync failure should be retried later rather than blamed on the
 * file being synced.
 *
 * Everything `isOfflineLikeError` covers, plus network failures in Chromium's
 * wording, expired sync tokens, server errors (5xx), request timeouts and rate
 * limiting. Use it to decide between "try again" and "set this file aside";
 * use `isOfflineLikeError` to decide what the status says.
 */
export function isTransientSyncError(
  error: unknown,
  isOfflineOverride?: OfflineDetector,
): boolean {
  if (isOfflineLikeError(error, isOfflineOverride)) {
    return true;
  }
  if (isLocalFileError(error)) {
    return false;
  }

  const status = getErrorField(error, "status");
  if (typeof status === "number" && (status >= 500 || status === 429 || status === 408)) {
    return true;
  }

  const code = getErrorField(error, "code");
  if (typeof code === "string" && TRANSIENT_ERROR_CODE.test(code.trim().toLowerCase())) {
    return true;
  }

  const message = getErrorText(error).toLowerCase();
  return TRANSIENT_ERROR_MARKERS.some((marker) => message.includes(marker));
}

// File-system failures, by the code Node gives them. Their message names the
// file, and a path is the user's own words: matched as text, a note under
// "Offline maps/" read as a dropped connection and was retried on every push
// forever, and one titled "Why the build timed out" as a server blip. The
// code decides before any text is matched, and none of these is the network.
const LOCAL_FILE_ERROR_CODES = new Set([
  "EACCES",
  "EPERM",
  "EISDIR",
  "ENOTDIR",
  "ENOENT",
  "EBUSY",
  "EROFS",
  "ENAMETOOLONG",
  "ELOOP",
]);

function isLocalFileError(error: unknown): boolean {
  const code = getErrorField(error, "code");
  if (typeof code === "string") {
    return LOCAL_FILE_ERROR_CODES.has(code);
  }

  // Node puts the code at the start of the message too, which survives an
  // error that was re-wrapped without its fields.
  const message = error instanceof Error ? error.message : String(error);
  const leading = /^([A-Z]+):/.exec(message)?.[1];
  return leading !== undefined && LOCAL_FILE_ERROR_CODES.has(leading);
}

function getErrorField(error: unknown, field: "status" | "code"): unknown {
  if (!error || typeof error !== "object" || !(field in error)) {
    return undefined;
  }

  return (error as Record<string, unknown>)[field];
}

function getErrorText(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name} ${error.message}`;
  }

  return String(error);
}
