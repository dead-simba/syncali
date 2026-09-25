/**
 * Why a change the server keeps rejecting as out of date could not be
 * reconciled, and was set aside instead of uploaded again.
 *
 * Each one is a different fault with a different fix, and the user can only be
 * told what to do if we know which it was - so they are kept apart all the way
 * to the message.
 */
export type StaleUnresolvedReason =
  /** The server predates fetching a single entry, so there was nothing to try. */
  | "fetch_unavailable"
  /** The server was asked for the entry and answered with an error. */
  | "fetch_failed"
  /** The server has no record of the entry at all. */
  | "not_on_server"
  /** The server's newer revision will not decrypt on this device. */
  | "undecryptable"
  /** The server's newer revision is at a path this device does not sync. */
  | "excluded"
  /** The newer revision was fetched and applied, and the change still did not fit. */
  | "not_applied"
  /** The same rejection kept coming back, recovery or not. */
  | "repeated";

export type StaleRecoveryOutcome =
  | {
      resolved: true;
      /**
       * `delete_undone` and `server_version_kept` are the pull's own answers
       * when a local change cannot be merged and there is no local file to
       * keep as a conflict copy: a delete of a file the server has since
       * changed, or an edit to a file that is gone from this device. Both end
       * with the server's version on disk, which is not the same thing as the
       * server already having this device's change.
       */
      how:
        | "merged"
        | "conflict_copy"
        | "already_on_server"
        | "delete_undone"
        | "server_version_kept";
    }
  | {
      resolved: false;
      reason: StaleUnresolvedReason;
      /** The revision the server sent back, when it sent one. */
      remoteRevision?: number;
      /** Where the server's copy lives, when that is the problem. */
      remotePath?: string;
      /** The server's own words, when it refused. */
      detail?: string;
    };

export interface StaleRecoveryEvent {
  entryId: string;
  mutationId: string;
  /** A parked delete needs different words from a parked edit. */
  op: "upsert" | "delete";
  /** The revision the server holds, from the rejection. */
  serverRevision: number;
  /** The revision this device's change was based on. */
  baseRevision: number;
  outcome: StaleRecoveryOutcome;
}

export type UnresolvedStaleRecoveryEvent = StaleRecoveryEvent & {
  outcome: Extract<StaleRecoveryOutcome, { resolved: false }>;
};

/**
 * Carried to `onMutationQuarantined` when a stale change is set aside, so the
 * notice can say which of the causes above it was rather than a generic
 * "could not be synced".
 */
export class StaleMutationUnresolvedError extends Error {
  constructor(readonly event: UnresolvedStaleRecoveryEvent) {
    super(describeStaleRecoveryOutcome(event));
    this.name = "StaleMutationUnresolvedError";
  }
}

/**
 * One line naming the revisions and what happened to them.
 *
 * This is the measurement for a stuck upload: which revision the server holds,
 * which one this device built on, and which of the known causes kept them
 * apart. It lands in Recent problems so it can be read off the device after
 * the fact.
 */
export function describeStaleRecoveryOutcome(event: StaleRecoveryEvent): string {
  const revisions =
    `server revision ${event.serverRevision}, ` +
    `this device's base revision ${event.baseRevision}`;
  const outcome = event.outcome;
  if (outcome.resolved) {
    switch (outcome.how) {
      case "merged":
        return `${revisions}: merged with the server's version`;
      case "conflict_copy":
        return `${revisions}: kept both versions, yours as a conflict copy`;
      case "already_on_server":
        return `${revisions}: the server already had this edit`;
      case "delete_undone":
        return `${revisions}: this device's delete was dropped and the server's version restored`;
      case "server_version_kept":
        return `${revisions}: kept the server's version, this device no longer had the file`;
    }
  }

  const fetched =
    outcome.remoteRevision === undefined
      ? "the server's version"
      : `the server's revision ${outcome.remoteRevision}`;
  switch (outcome.reason) {
    case "fetch_unavailable":
      return `${revisions}: set aside, this server cannot send one file's state`;
    case "fetch_failed":
      return `${revisions}: set aside, the server refused to send it${
        outcome.detail ? ` (${outcome.detail})` : ""
      }`;
    case "not_on_server":
      return `${revisions}: set aside, the server has no record of this file`;
    case "undecryptable":
      return `${revisions}: set aside, ${fetched} could not be decrypted on this device`;
    case "excluded":
      return `${revisions}: set aside, ${fetched} is at "${outcome.remotePath ?? "an unknown path"}", which this device does not sync`;
    case "not_applied":
      return `${revisions}: set aside, ${fetched} was fetched but did not replace this device's base`;
    case "repeated":
      return `${revisions}: set aside, the server kept rejecting it the same way`;
  }
}

/** What the user can do about each cause, in the order they should try it. */
export function adviseOnUnresolvedStale(
  outcome: Extract<StaleRecoveryOutcome, { resolved: false }>,
  op: "upsert" | "delete" = "upsert",
): string {
  if (op === "delete") {
    // Everything that fixes an edit undoes a delete. Once the server's newer
    // version can be brought down, the pull keeps it over a delete made from
    // an older one and puts the file back here. The delete only lands from a
    // device that already has the newer version.
    const where =
      outcome.reason === "undecryptable"
        ? "the device that last changed it"
        : outcome.reason === "excluded"
          ? "a device that syncs that path"
          : "another device";
    return (
      `To remove it everywhere, delete it on ${where}. ` +
      "Choosing Try these again under Files not syncing in Syncali settings does not " +
      "finish the delete: once this device can bring the newer version down, that " +
      "version comes back here."
    );
  }

  switch (outcome.reason) {
    case "undecryptable":
      return (
        "Open the note on the device that last changed it and save it again, " +
        "then choose Try these again under Files not syncing in Syncali settings."
      );
    case "excluded":
      // Trying again with the rules unchanged only fetches the same excluded
      // copy and sets the change aside again, so the rules come first.
      return (
        "Change your sync rules to include that path, then choose Try these again " +
        "under Files not syncing in Syncali settings."
      );
    default:
      return (
        "Choose Try these again under Files not syncing in Syncali settings. " +
        "If it is set aside again, copy your edit somewhere safe, then disconnect " +
        "and reconnect the vault."
      );
  }
}
