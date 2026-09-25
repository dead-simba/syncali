import { afterEach, describe, expect, it, vi } from "vitest";

import { closeAllTestSqliteCoordinators, createSqliteCoordinator, testSession } from "./helpers";

const STAGE_GRACE_PERIOD_MS = 30 * 60 * 1000;
const VERSION_HISTORY_RETENTION_MS = 24 * 60 * 60 * 1000;

afterEach(() => {
	closeAllTestSqliteCoordinators();
});

describe("sqlite backend: mutation commits", () => {
	it("accepts a fresh upsert and advances the cursor", async () => {
		const { mutationStore, entryStore } = await createSqliteCoordinator();
		const session = testSession();

		const result = await mutationStore.commitMutations(
			session,
			{
				type: "commit_mutations",
				requestId: "req-1",
				mutations: [
					{
						mutationId: "mutation-1",
						entryId: "entry-1",
						op: "upsert",
						baseRevision: 0,
						blobId: null,
						encryptedMetadata: "ciphertext-a",
					},
				],
			},
			STAGE_GRACE_PERIOD_MS,
			VERSION_HISTORY_RETENTION_MS,
		);

		expect(result.message.results).toMatchObject([
			{ status: "accepted", mutationId: "mutation-1", entryId: "entry-1", revision: 1 },
		]);
		expect(entryStore.readEntry("entry-1")).toMatchObject({
			entry_id: "entry-1",
			revision: 1,
			encrypted_metadata: "ciphertext-a",
			deleted: 0,
		});
	});

	it("rejects duplicate mutation ids within the same batch", async () => {
		const { mutationStore } = await createSqliteCoordinator();
		const session = testSession();

		const result = await mutationStore.commitMutations(
			session,
			{
				type: "commit_mutations",
				requestId: "req-dup",
				mutations: [
					{
						mutationId: "dup",
						entryId: "entry-1",
						op: "upsert",
						baseRevision: 0,
						blobId: null,
						encryptedMetadata: "a",
					},
					{
						mutationId: "dup",
						entryId: "entry-2",
						op: "upsert",
						baseRevision: 0,
						blobId: null,
						encryptedMetadata: "b",
					},
				],
			},
			STAGE_GRACE_PERIOD_MS,
			VERSION_HISTORY_RETENTION_MS,
		);

		expect(result.message.results).toMatchObject([
			{ status: "accepted", mutationId: "dup" },
			{ status: "rejected", mutationId: "dup", code: "duplicate_mutation_id" },
		]);
	});

	it("rejects a stale base revision", async () => {
		const { mutationStore } = await createSqliteCoordinator();
		const session = testSession();
		const commit = (mutationId: string, baseRevision: number) =>
			mutationStore.commitMutations(
				session,
				{
					type: "commit_mutations",
					requestId: `req-${mutationId}`,
					mutations: [
						{
							mutationId,
							entryId: "entry-1",
							op: "upsert",
							baseRevision,
							blobId: null,
							encryptedMetadata: "ciphertext",
						},
					],
				},
				STAGE_GRACE_PERIOD_MS,
				VERSION_HISTORY_RETENTION_MS,
			);

		await commit("mutation-1", 0);
		const stale = await commit("mutation-2", 0);

		expect(stale.message.results).toMatchObject([
			{
				status: "rejected",
				mutationId: "mutation-2",
				code: "stale_revision",
				expectedBaseRevision: 1,
				receivedBaseRevision: 0,
			},
		]);
	});

	it("logs a stale rejection as one JSON line without metadata", async () => {
		const { mutationStore } = await createSqliteCoordinator();
		const session = testSession({ localVaultId: "local-vault-mac" });
		const commit = (mutationId: string, baseRevision: number) =>
			mutationStore.commitMutations(
				session,
				{
					type: "commit_mutations",
					requestId: `req-${mutationId}`,
					mutations: [
						{
							mutationId,
							entryId: "entry-1",
							op: "upsert",
							baseRevision,
							blobId: null,
							encryptedMetadata: "secret-ciphertext",
						},
					],
				},
				STAGE_GRACE_PERIOD_MS,
				VERSION_HISTORY_RETENTION_MS,
			);
		await commit("mutation-1", 0);
		await commit("mutation-2", 1);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		try {
			await commit("mutation-3", 1);

			expect(warn).toHaveBeenCalledTimes(1);
			const [line] = warn.mock.calls[0] ?? [];
			expect(typeof line).toBe("string");
			expect(JSON.parse(line as string)).toEqual({
				event: "stale_revision",
				vaultId: "vault-1",
				localVaultId: "local-vault-mac",
				entryId: "entry-1",
				expectedBaseRevision: 2,
				receivedBaseRevision: 1,
			});
			expect(line).not.toContain("secret-ciphertext");
		} finally {
			warn.mockRestore();
		}
	});

	it("does not log an accepted commit", async () => {
		const { mutationStore } = await createSqliteCoordinator();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		try {
			await mutationStore.commitMutations(
				testSession(),
				{
					type: "commit_mutations",
					requestId: "req-accepted",
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
				},
				STAGE_GRACE_PERIOD_MS,
				VERSION_HISTORY_RETENTION_MS,
			);

			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it("does not log a stale rejection from a batch that rolled back", async () => {
		const { mutationStore } = await createSqliteCoordinator();
		const mutation = (mutationId: string, entryId: string) => ({
			mutationId,
			entryId,
			op: "upsert" as const,
			baseRevision: 0,
			blobId: null,
			encryptedMetadata: "ciphertext",
		});
		await mutationStore.commitMutations(
			testSession(),
			{
				type: "commit_mutations",
				requestId: "req-first",
				mutations: [mutation("mutation-1", "entry-1")],
			},
			STAGE_GRACE_PERIOD_MS,
			VERSION_HISTORY_RETENTION_MS,
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		try {
			// The first mutation is stale. The second needs a cursor, and a
			// session for another vault makes allocating one throw, which rolls
			// the batch back before the client is told about either.
			const commit = mutationStore.commitMutations(
				testSession({ vaultId: "vault-other" }),
				{
					type: "commit_mutations",
					requestId: "req-rolled-back",
					mutations: [mutation("mutation-2", "entry-1"), mutation("mutation-3", "entry-2")],
				},
				STAGE_GRACE_PERIOD_MS,
				VERSION_HISTORY_RETENTION_MS,
			);

			await expect(commit).rejects.toThrow("durable object vault id mismatch");
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it("replays an already-applied mutation id idempotently", async () => {
		const { mutationStore } = await createSqliteCoordinator();
		const session = testSession();
		const message = {
			type: "commit_mutations" as const,
			requestId: "req-replay",
			mutations: [
				{
					mutationId: "mutation-1",
					entryId: "entry-1",
					op: "upsert" as const,
					baseRevision: 0,
					blobId: null,
					encryptedMetadata: "ciphertext",
				},
			],
		};

		const first = await mutationStore.commitMutations(
			session,
			message,
			STAGE_GRACE_PERIOD_MS,
			VERSION_HISTORY_RETENTION_MS,
		);
		const replay = await mutationStore.commitMutations(
			session,
			message,
			STAGE_GRACE_PERIOD_MS,
			VERSION_HISTORY_RETENTION_MS,
		);

		expect(replay.message.results).toEqual(first.message.results);
	});

	it("commits accepted mutations in a batch alongside a rejected sibling", async () => {
		const { mutationStore, entryStore, cursorStore } = await createSqliteCoordinator();
		const session = testSession();

		const result = await mutationStore.commitMutations(
			session,
			{
				type: "commit_mutations",
				requestId: "req-partial",
				mutations: [
					{
						mutationId: "mutation-ok",
						entryId: "entry-1",
						op: "upsert",
						baseRevision: 0,
						blobId: null,
						encryptedMetadata: "ciphertext-a",
					},
					{
						mutationId: "mutation-bad-blob",
						entryId: "entry-2",
						op: "upsert",
						baseRevision: 0,
						blobId: "unstaged-blob",
						encryptedMetadata: "ciphertext-b",
					},
				],
			},
			STAGE_GRACE_PERIOD_MS,
			VERSION_HISTORY_RETENTION_MS,
		);

		expect(result.message.results).toMatchObject([
			{ status: "accepted", mutationId: "mutation-ok", entryId: "entry-1" },
			{ status: "rejected", mutationId: "mutation-bad-blob", code: "blob_not_staged" },
		]);
		expect(entryStore.readEntry("entry-1")).toMatchObject({ revision: 1 });
		expect(entryStore.readEntry("entry-2")).toBeNull();
		expect(cursorStore.currentCursor()).toBe(1);
	});

	it("accepts exactly one of several concurrent commits racing the same base revision", async () => {
		const { mutationStore, entryStore, cursorStore } = await createSqliteCoordinator();
		const session = testSession();

		// Each commit's DB work runs inside a single synchronous
		// better-sqlite3 transaction with no `await` in the middle, so
		// Promise.all here can't actually interleave two commits' reads and
		// writes - this pins that invariant. If a future change threads an
		// `await` into the transaction body, this test starts failing instead
		// of silently double-accepting a stale base revision.
		const attempts = await Promise.all(
			Array.from({ length: 5 }, (_, index) =>
				mutationStore.commitMutations(
					session,
					{
						type: "commit_mutations",
						requestId: `req-race-${index}`,
						mutations: [
							{
								mutationId: `mutation-race-${index}`,
								entryId: "entry-1",
								op: "upsert",
								baseRevision: 0,
								blobId: null,
								encryptedMetadata: `ciphertext-${index}`,
							},
						],
					},
					STAGE_GRACE_PERIOD_MS,
					VERSION_HISTORY_RETENTION_MS,
				),
			),
		);

		const results = attempts.map((attempt) => attempt.message.results[0]);
		expect(results.filter((result) => result.status === "accepted")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(4);
		expect(
			results
				.filter((result) => result.status === "rejected")
				.every((result) => result.code === "stale_revision"),
		).toBe(true);
		expect(entryStore.readEntry("entry-1")).toMatchObject({ revision: 1 });
		expect(cursorStore.currentCursor()).toBe(1);
	});
});
