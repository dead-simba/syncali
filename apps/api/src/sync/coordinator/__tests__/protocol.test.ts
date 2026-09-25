import { describe, expect, it } from "vitest";

import {
	formatClientControlMessageError,
	MAX_ENTRY_STATES_BY_ID,
	parseClientControlMessage,
} from "../protocol";

describe("sync protocol schema", () => {
	it("accepts a valid hello message", () => {
		const parsed = parseClientControlMessage({
			type: "hello",
			requestId: "request-hello",
			lastKnownCursor: 0,
		});

		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			throw new Error("expected hello message to parse");
		}

		expect(parsed.data).toEqual({
			type: "hello",
			requestId: "request-hello",
			lastKnownCursor: 0,
		});
	});

	it("rejects a negative hello cursor", () => {
		const parsed = parseClientControlMessage({
			type: "hello",
			requestId: "request-hello",
			lastKnownCursor: -1,
		});

		expect(parsed.success).toBe(false);
		if (parsed.success) {
			throw new Error("expected hello message to fail");
		}

		expect(formatClientControlMessageError(parsed.error)).toContain("lastKnownCursor");
	});

	it("accepts a local vault detach request", () => {
		const parsed = parseClientControlMessage({
			type: "detach_local_vault",
			requestId: "request-detach",
		});

		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			throw new Error("expected detach local vault message to parse");
		}

		expect(parsed.data).toEqual({
			type: "detach_local_vault",
			requestId: "request-detach",
		});
	});

	it("accepts an entry-state delta page request", () => {
		const parsed = parseClientControlMessage({
			type: "list_entry_states",
			requestId: "request-entry-states",
			sinceCursor: 12,
			targetCursor: 20,
			after: {
				updatedSeq: 14,
				entryId: "entry-1",
			},
			limit: 100,
		});

		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			throw new Error("expected entry states message to parse");
		}

		expect(parsed.data).toEqual({
			type: "list_entry_states",
			requestId: "request-entry-states",
			sinceCursor: 12,
			targetCursor: 20,
			after: {
				updatedSeq: 14,
				entryId: "entry-1",
			},
			limit: 100,
		});
	});

	it("accepts an entry-state lookup by id", () => {
		const parsed = parseClientControlMessage({
			type: "get_entry_states",
			requestId: "request-entry-states-by-id",
			entryIds: ["entry-1", "entry-2"],
		});

		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			throw new Error("expected entry states by id message to parse");
		}

		expect(parsed.data).toEqual({
			type: "get_entry_states",
			requestId: "request-entry-states-by-id",
			entryIds: ["entry-1", "entry-2"],
		});
	});

	it("accepts an entry-state lookup of exactly the maximum batch", () => {
		const parsed = parseClientControlMessage({
			type: "get_entry_states",
			requestId: "request-entry-states-by-id",
			entryIds: Array.from({ length: MAX_ENTRY_STATES_BY_ID }, (_, i) => `entry-${i}`),
		});

		expect(parsed.success).toBe(true);
	});

	it.each([
		{
			name: "no ids",
			entryIds: [],
			error: "entryIds: Too small: expected array to have >=1 items",
		},
		{
			name: "more ids than one batch allows",
			entryIds: Array.from({ length: MAX_ENTRY_STATES_BY_ID + 1 }, (_, i) => `entry-${i}`),
			error: "entryIds: Too big: expected array to have <=100 items",
		},
		{
			name: "a blank id",
			entryIds: ["entry-1", "  "],
			error: "entryIds.1: Too small: expected string to have >=1 characters",
		},
		{
			name: "a repeated id",
			entryIds: ["entry-1", "entry-2", "entry-1"],
			error: "entryIds: entry ids must be unique",
		},
	])("rejects an entry-state lookup with $name", ({ entryIds, error }) => {
		const parsed = parseClientControlMessage({
			type: "get_entry_states",
			requestId: "request-entry-states-by-id",
			entryIds,
		});

		expect(parsed.success).toBe(false);
		if (parsed.success) {
			throw new Error("expected entry states by id message to fail");
		}

		expect(formatClientControlMessageError(parsed.error)).toBe(error);
	});

	it("accepts an entry history request", () => {
		const parsed = parseClientControlMessage({
			type: "list_entry_versions",
			requestId: "request-history",
			entryId: "entry-1",
			before: null,
			limit: 100,
		});

		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			throw new Error("expected entry history message to parse");
		}

		expect(parsed.data).toEqual({
			type: "list_entry_versions",
			requestId: "request-history",
			entryId: "entry-1",
			before: null,
			limit: 100,
		});
	});

	it("accepts a deleted entries request", () => {
		const parsed = parseClientControlMessage({
			type: "list_deleted_entries",
			requestId: "request-deleted",
			before: {
				deletedAt: 20,
				entryId: "entry-1",
			},
			limit: 25,
		});

		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			throw new Error("expected deleted entries message to parse");
		}

		expect(parsed.data).toEqual({
			type: "list_deleted_entries",
			requestId: "request-deleted",
			before: {
				deletedAt: 20,
				entryId: "entry-1",
			},
			limit: 25,
		});
	});

	it("accepts an entry restore request", () => {
		const parsed = parseClientControlMessage({
			type: "restore_entry_version",
			requestId: "request-restore",
			entryId: "entry-1",
			versionId: "version-1",
			baseRevision: 2,
			op: "upsert",
			blobId: "blob-1",
			encryptedMetadata: "ciphertext",
		});

		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			throw new Error("expected entry restore message to parse");
		}

		expect(parsed.data).toEqual({
			type: "restore_entry_version",
			requestId: "request-restore",
			entryId: "entry-1",
			versionId: "version-1",
			baseRevision: 2,
			op: "upsert",
			blobId: "blob-1",
			encryptedMetadata: "ciphertext",
		});
	});

	it("accepts an entry restore batch request", () => {
		const parsed = parseClientControlMessage({
			type: "restore_entry_versions",
			requestId: "request-restore-batch",
			restores: [
				{
					entryId: "entry-1",
					versionId: "version-1",
					baseRevision: 2,
					op: "upsert",
					blobId: "blob-1",
					encryptedMetadata: "ciphertext",
				},
			],
		});

		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			throw new Error("expected entry restore batch message to parse");
		}

		expect(parsed.data).toEqual({
			type: "restore_entry_versions",
			requestId: "request-restore-batch",
			restores: [
				{
					entryId: "entry-1",
					versionId: "version-1",
					baseRevision: 2,
					op: "upsert",
					blobId: "blob-1",
					encryptedMetadata: "ciphertext",
				},
			],
		});
	});

	it("accepts a commit batch", () => {
		const parsed = parseClientControlMessage({
			type: "commit_mutations",
			requestId: "request-commit",
			mutations: [
				{
					mutationId: "mutation-1",
					entryId: "entry-1",
					op: "delete",
					baseRevision: 1,
					blobId: null,
					encryptedMetadata: "ciphertext",
				},
			],
		});

		expect(parsed.success).toBe(true);
		if (!parsed.success) {
			throw new Error("expected commit batch to parse");
		}

		expect(parsed.data).toEqual({
			type: "commit_mutations",
			requestId: "request-commit",
			mutations: [
				{
					mutationId: "mutation-1",
					entryId: "entry-1",
					op: "delete",
					baseRevision: 1,
					blobId: null,
					encryptedMetadata: "ciphertext",
				},
			],
		});
	});

	it("rejects a blank entry id", () => {
		const parsed = parseClientControlMessage({
			type: "commit_mutations",
			requestId: "request-commit",
			mutations: [
				{
					mutationId: "mutation-1",
					entryId: "   ",
					op: "upsert",
					baseRevision: 0,
					blobId: "blob-1",
					encryptedMetadata: "ciphertext",
				},
			],
		});

		expect(parsed.success).toBe(false);
		if (parsed.success) {
			throw new Error("expected commit mutation to fail");
		}

		expect(formatClientControlMessageError(parsed.error)).toContain(
			"mutations.0.entryId",
		);
	});

	it("rejects an upsert mutation without a blob id", () => {
		const parsed = parseClientControlMessage({
			type: "commit_mutations",
			requestId: "request-commit",
			mutations: [
				{
					mutationId: "mutation-1",
					entryId: "entry-1",
					op: "upsert",
					baseRevision: 0,
					blobId: null,
					encryptedMetadata: "ciphertext",
				},
			],
		});

		expect(parsed.success).toBe(false);
		if (parsed.success) {
			throw new Error("expected upsert mutation to fail");
		}

		expect(formatClientControlMessageError(parsed.error)).toBe(
			"mutations.0.blobId: upsert mutations must include a blobId",
		);
	});

	it("rejects a delete mutation that still includes a blob id", () => {
		const parsed = parseClientControlMessage({
			type: "commit_mutations",
			requestId: "request-commit",
			mutations: [
				{
					mutationId: "mutation-1",
					entryId: "entry-1",
					op: "delete",
					baseRevision: 1,
					blobId: "blob-1",
					encryptedMetadata: "ciphertext",
				},
			],
		});

		expect(parsed.success).toBe(false);
		if (parsed.success) {
			throw new Error("expected delete mutation to fail");
		}

		expect(formatClientControlMessageError(parsed.error)).toBe(
			"mutations.0.blobId: delete mutations must not include a blobId",
		);
	});
});
