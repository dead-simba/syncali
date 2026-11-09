import {
  isConnectionDropError,
  isServerUnavailableError,
  type OfflineDetector,
} from "../../http/network-status";
import { platformRefusedName } from "../vault/vault-writer";

/**
 * The kinds of problem a device report counts. Codes, not text: they travel in
 * the readable half of the report, which must never carry a file name.
 */
export const PROBLEM_KINDS = [
  "connection_drop",
  "server_unavailable",
  "name_refused",
  "write_failed",
  "sync_error",
  "conflict",
  "set_aside",
  "unreadable_entry",
  "stale_recovered",
] as const;

export type ProblemKind = (typeof PROBLEM_KINDS)[number];

/** Same tests the notice uses, so a count and a notice never disagree. */
export function classifySyncError(error: unknown, isOffline?: OfflineDetector): ProblemKind {
  if (platformRefusedName(error)) {
    return "name_refused";
  }
  if (isConnectionDropError(error, isOffline)) {
    return "connection_drop";
  }
  if (isServerUnavailableError(error)) {
    return "server_unavailable";
  }
  if (error instanceof Error && error.name === "VaultWriteError") {
    return "write_failed";
  }
  return "sync_error";
}
