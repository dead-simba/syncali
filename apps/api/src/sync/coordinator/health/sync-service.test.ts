import { describe, expect, it, vi } from "vitest";

import { HealthSyncService } from "./sync-service";
import type { HealthStateStore } from "../ports";

describe("HealthSyncService", () => {
	it("coalesces delayed health summary flush scheduling", async () => {
		const stateRepository = createStateRepository();
		const deferMaintenance = vi.fn(async () => {});
		const service = new HealthSyncService(
			stateRepository,
			null,
			30 * 24 * 60 * 60 * 1000,
			{ defer: deferMaintenance },
		);

		await service.scheduleSummaryFlush(1_000);
		await service.scheduleSummaryFlush(30_000);
		await service.scheduleSummaryFlush(60_999);

		expect(deferMaintenance).toHaveBeenCalledTimes(1);
		expect(deferMaintenance).toHaveBeenCalledWith(
			"health_summary_flush",
			601_000,
			1_000,
		);
	});

	it("keeps the earliest scheduled flush after later activity", async () => {
		const stateRepository = createStateRepository();
		const deferMaintenance = vi.fn(async () => {});
		const service = new HealthSyncService(
			stateRepository,
			null,
			30 * 24 * 60 * 60 * 1000,
			{ defer: deferMaintenance },
		);

		await service.scheduleSummaryFlush(1_000);
		await service.scheduleSummaryFlush(61_000);

		expect(deferMaintenance).toHaveBeenCalledTimes(1);
	});

	it("allows the next activity to schedule after a successful flush", async () => {
		const stateRepository = createStateRepository({
			readHealthSummary: vi.fn(() => ({
				vaultId: "vault-1",
				healthStatus: "ok" as const,
				healthReasons: [],
				currentCursor: 1,
				entryCount: 1,
				liveBlobCount: 1,
				stagedBlobCount: 0,
				pendingDeleteBlobCount: 0,
				storageUsedBytes: 10,
				storageLimitBytes: 100,
				activeLocalVaultCount: 1,
				websocketCount: 1,
				oldestStagedBlobAgeMs: null,
				oldestPendingDeleteAgeMs: null,
				lastCommitAt: 1_000,
				lastGcAt: null,
			})),
			recordHealthSummaryFlushed: vi.fn(),
		});
		const syncStatusRepository = {
			upsert: vi.fn(async () => {}),
		};
		const deferMaintenance = vi.fn(async () => {});
		const service = new HealthSyncService(
			stateRepository,
			syncStatusRepository,
			30 * 24 * 60 * 60 * 1000,
			{ defer: deferMaintenance },
		);

		await service.scheduleSummaryFlush(1_000);
		await service.flushSummary({ now: 61_000 });
		await service.scheduleSummaryFlush(62_000);

		expect(deferMaintenance).toHaveBeenCalledTimes(2);
	});
});

function createStateRepository(
	overrides: Partial<HealthStateStore> = {},
): HealthStateStore {
	return {
		recordGcCompleted: vi.fn(),
		readHealthSummary: vi.fn(() => null),
		recordHealthSummaryFlushed: vi.fn(),
		recordHealthSummaryFlushFailed: vi.fn(() => 1),
		readStorageStatus: vi.fn(() => ({
			storageUsedBytes: 0,
			storageLimitBytes: 100,
		})),
		...overrides,
	};
}
