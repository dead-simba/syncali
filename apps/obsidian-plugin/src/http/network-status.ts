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

  const message = getErrorText(error).toLowerCase();
  return OFFLINE_ERROR_MARKERS.some((marker) => message.includes(marker));
}

function getErrorText(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name} ${error.message}`;
  }

  return String(error);
}
