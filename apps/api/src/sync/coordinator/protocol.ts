import { z, type ZodError } from "zod";

const nonEmptyString = z.string().trim().min(1);

const nonNegativeInteger = z.number().int().min(0);
const positiveInteger = z.number().int().positive();
const requestIdSchema = nonEmptyString;

export const commitMutationPayloadSchema = z
	.object({
		mutationId: nonEmptyString,
		entryId: nonEmptyString,
		op: z.enum(["upsert", "delete"]),
		baseRevision: nonNegativeInteger,
		blobId: nonEmptyString.nullable(),
		encryptedMetadata: nonEmptyString,
	})
	.superRefine((mutation, ctx) => {
		if (mutation.op === "upsert" && mutation.blobId === null) {
			ctx.addIssue({
				code: "custom",
				path: ["blobId"],
				message: "upsert mutations must include a blobId",
			});
		}
		if (mutation.op === "delete" && mutation.blobId !== null) {
			ctx.addIssue({
				code: "custom",
				path: ["blobId"],
				message: "delete mutations must not include a blobId",
			});
		}
	});

export const helloMessageSchema = z.object({
	type: z.literal("hello"),
	requestId: requestIdSchema,
	lastKnownCursor: nonNegativeInteger,
});

export const commitMutationMessageSchema = z.object({
	type: z.literal("commit_mutation"),
	requestId: requestIdSchema,
	mutation: commitMutationPayloadSchema,
});

export const commitMutationsMessageSchema = z.object({
	type: z.literal("commit_mutations"),
	requestId: requestIdSchema,
	mutations: z.array(commitMutationPayloadSchema).min(1).max(100),
});

const entryStatePageCursorSchema = z.object({
	updatedSeq: nonNegativeInteger,
	entryId: nonEmptyString,
});

export const listEntryStatesMessageSchema = z.object({
	type: z.literal("list_entry_states"),
	requestId: requestIdSchema,
	sinceCursor: nonNegativeInteger,
	targetCursor: nonNegativeInteger.nullable(),
	after: entryStatePageCursorSchema.nullable(),
	limit: positiveInteger,
});

/**
 * Optional capabilities this server advertises in `hello_ack.features`. A
 * client may only send a message listed here: a server that predates it
 * answers with a `session_error` that carries no requestId, which the client
 * cannot tie back to the request it was waiting on.
 */
export const COORDINATOR_FEATURES = ["get_entry_states"] as const;

export const MAX_ENTRY_STATES_BY_ID = 100;

/**
 * Looks entries up by id rather than by cursor. A client needs this when it
 * holds a local change for an entry whose newer server revision it never
 * recorded, for example because its cursor already moved past that revision.
 * Paging by cursor never returns such an entry again, so without a direct
 * lookup the client keeps committing against a revision the server has left
 * behind.
 */
export const getEntryStatesMessageSchema = z.object({
	type: z.literal("get_entry_states"),
	requestId: requestIdSchema,
	entryIds: z
		.array(nonEmptyString)
		.min(1)
		.max(MAX_ENTRY_STATES_BY_ID)
		.refine((entryIds) => new Set(entryIds).size === entryIds.length, {
			message: "entry ids must be unique",
		}),
});

const entryVersionPageCursorSchema = z.object({
	capturedAt: nonNegativeInteger,
	versionId: nonEmptyString,
});

const deletedEntryPageCursorSchema = z.object({
	deletedAt: nonNegativeInteger,
	entryId: nonEmptyString,
});

export const listEntryVersionsMessageSchema = z.object({
	type: z.literal("list_entry_versions"),
	requestId: requestIdSchema,
	entryId: nonEmptyString,
	before: entryVersionPageCursorSchema.nullable(),
	limit: positiveInteger,
});

export const listDeletedEntriesMessageSchema = z.object({
	type: z.literal("list_deleted_entries"),
	requestId: requestIdSchema,
	before: deletedEntryPageCursorSchema.nullable(),
	limit: positiveInteger,
});

export const restoreEntryVersionMessageSchema = z.object({
	type: z.literal("restore_entry_version"),
	requestId: requestIdSchema,
	entryId: nonEmptyString,
	versionId: nonEmptyString,
	baseRevision: nonNegativeInteger,
	op: z.enum(["upsert", "delete"]),
	blobId: nonEmptyString.nullable(),
	encryptedMetadata: nonEmptyString,
});

const restoreEntryVersionPayloadSchema = restoreEntryVersionMessageSchema.omit({
	type: true,
	requestId: true,
});

export const restoreEntryVersionsMessageSchema = z.object({
	type: z.literal("restore_entry_versions"),
	requestId: requestIdSchema,
	restores: z.array(restoreEntryVersionPayloadSchema).min(1).max(100),
});

const purgeDeletedEntryPayloadSchema = z.object({
	entryId: nonEmptyString,
	revision: nonNegativeInteger,
});

export const purgeDeletedEntriesMessageSchema = z.object({
	type: z.literal("purge_deleted_entries"),
	requestId: requestIdSchema,
	entries: z.array(purgeDeletedEntryPayloadSchema).min(1).max(100),
});

export const detachLocalVaultMessageSchema = z.object({
	type: z.literal("detach_local_vault"),
	requestId: requestIdSchema,
});

export const heartbeatMessageSchema = z.object({
	type: z.literal("heartbeat"),
	requestId: requestIdSchema,
});

export const watchStorageStatusMessageSchema = z.object({
	type: z.literal("watch_storage_status"),
});

export const unwatchStorageStatusMessageSchema = z.object({
	type: z.literal("unwatch_storage_status"),
});

export const clientControlMessageSchema = z.discriminatedUnion("type", [
	helloMessageSchema,
	commitMutationsMessageSchema,
	listEntryStatesMessageSchema,
	getEntryStatesMessageSchema,
	listEntryVersionsMessageSchema,
	listDeletedEntriesMessageSchema,
	restoreEntryVersionMessageSchema,
	restoreEntryVersionsMessageSchema,
	purgeDeletedEntriesMessageSchema,
	detachLocalVaultMessageSchema,
	heartbeatMessageSchema,
	watchStorageStatusMessageSchema,
	unwatchStorageStatusMessageSchema,
]);

export type HelloMessage = z.infer<typeof helloMessageSchema>;
export type CommitMutationPayload = z.infer<typeof commitMutationPayloadSchema>;
export type CommitMutationMessage = z.infer<typeof commitMutationMessageSchema>;
export type CommitMutationsMessage = z.infer<typeof commitMutationsMessageSchema>;
export type ListEntryStatesMessage = z.infer<typeof listEntryStatesMessageSchema>;
export type GetEntryStatesMessage = z.infer<typeof getEntryStatesMessageSchema>;
export type CoordinatorFeature = (typeof COORDINATOR_FEATURES)[number];
export type ListEntryVersionsMessage = z.infer<typeof listEntryVersionsMessageSchema>;
export type ListDeletedEntriesMessage = z.infer<typeof listDeletedEntriesMessageSchema>;
export type RestoreEntryVersionMessage = z.infer<typeof restoreEntryVersionMessageSchema>;
export type RestoreEntryVersionsMessage = z.infer<typeof restoreEntryVersionsMessageSchema>;
export type PurgeDeletedEntriesMessage = z.infer<typeof purgeDeletedEntriesMessageSchema>;
export type DetachLocalVaultMessage = z.infer<typeof detachLocalVaultMessageSchema>;
export type HeartbeatMessage = z.infer<typeof heartbeatMessageSchema>;
export type WatchStorageStatusMessage = z.infer<typeof watchStorageStatusMessageSchema>;
export type UnwatchStorageStatusMessage = z.infer<typeof unwatchStorageStatusMessageSchema>;
export type ClientControlMessage = z.infer<typeof clientControlMessageSchema>;

export function parseClientControlMessage(value: unknown) {
	return clientControlMessageSchema.safeParse(value);
}

export function formatClientControlMessageError(error: ZodError): string {
	const issue = error.issues[0];
	if (!issue) {
		return "invalid websocket message";
	}

	const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
	return `${path}${issue.message}`;
}
