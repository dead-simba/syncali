import { afterEach, describe, expect, it } from "vitest";

import { closeAllTestSqliteCoordinators, createSqliteCoordinator, testSession } from "./helpers";

const STAGE_GRACE_PERIOD_MS = 30 * 60 * 1000;
const VERSION_HISTORY_RETENTION_MS = 24 * 60 * 60 * 1000;

afterEach(() => {
	closeAllTestSqliteCoordinators();
});

async function seedEntries(
	coordinator: Awaited<ReturnType<typeof createSqliteCoordinator>>,
	mutations: Array<{ entryId: string; op: "upsert" | "delete"; baseRevision: number }>,
) {
	for (const [index, mutation] of mutations.entries()) {
		await coordinator.mutationStore.commitMutations(
			testSession(),
			{
				type: "commit_mutations",
				requestId: `req-${index}`,
				mutations: [
					{
						mutationId: `mutation-${index}`,
						entryId: mutation.entryId,
						op: mutation.op,
						baseRevision: mutation.baseRevision,
						blobId: null,
						encryptedMetadata: `ciphertext-${mutation.entryId}-${mutation.baseRevision}`,
					},
				],
			},
			STAGE_GRACE_PERIOD_MS,
			VERSION_HISTORY_RETENTION_MS,
		);
	}
}

describe("sqlite backend: entry-state lookup by id", () => {
	it("returns the current state of each known id, including deletions, and skips unknown ids", async () => {
		const coordinator = await createSqliteCoordinator();
		await seedEntries(coordinator, [
			{ entryId: "entry-1", op: "upsert", baseRevision: 0 },
			{ entryId: "entry-2", op: "upsert", baseRevision: 0 },
			{ entryId: "entry-1", op: "upsert", baseRevision: 1 },
			{ entryId: "entry-2", op: "delete", baseRevision: 1 },
			{ entryId: "entry-3", op: "upsert", baseRevision: 0 },
		]);

		const rows = coordinator.entryStore.readEntryStates(["entry-2", "entry-missing", "entry-1"]);

		expect(rows.sort((a, b) => a.entry_id.localeCompare(b.entry_id))).toEqual([
			{
				entry_id: "entry-1",
				revision: 2,
				blob_id: null,
				encrypted_metadata: "ciphertext-entry-1-1",
				deleted: false,
				updated_seq: 3,
				updated_at: expect.any(Number),
			},
			{
				entry_id: "entry-2",
				revision: 2,
				blob_id: null,
				encrypted_metadata: "ciphertext-entry-2-1",
				deleted: true,
				updated_seq: 4,
				updated_at: expect.any(Number),
			},
		]);
	});

	it("finds an entry the client's cursor has already passed", async () => {
		// This is the case paging by cursor cannot recover from: the entry last
		// changed at seq 1, so any page requested from a later cursor skips it.
		const coordinator = await createSqliteCoordinator();
		await seedEntries(coordinator, [
			{ entryId: "entry-behind", op: "upsert", baseRevision: 0 },
			{ entryId: "entry-other", op: "upsert", baseRevision: 0 },
		]);

		expect(coordinator.entryStore.listEntryStates(1, 2, null, 100)).toEqual([
			expect.objectContaining({ entry_id: "entry-other" }),
		]);
		expect(coordinator.entryStore.readEntryStates(["entry-behind"])).toEqual([
			expect.objectContaining({ entry_id: "entry-behind", revision: 1, updated_seq: 1 }),
		]);
	});

	it("looks up a full batch of ids in one statement", async () => {
		const coordinator = await createSqliteCoordinator();
		await seedEntries(coordinator, [{ entryId: "entry-42", op: "upsert", baseRevision: 0 }]);

		const rows = coordinator.entryStore.readEntryStates(
			Array.from({ length: 100 }, (_, i) => `entry-${i}`),
		);

		expect(rows.map((row) => row.entry_id)).toEqual(["entry-42"]);
	});

	it("returns nothing for an empty id list", async () => {
		const coordinator = await createSqliteCoordinator();

		expect(coordinator.entryStore.readEntryStates([])).toEqual([]);
	});
});
