import type { MaintenanceScheduler } from "../maintenance-scheduler";
import type { HealthStateStore } from "../ports";
import type { VaultSyncStatusSummary } from "../../health/types";

const DEFAULT_HEALTH_SUMMARY_FLUSH_DELAY_MS = 10 * 60 * 1000;

export interface VaultSyncStatusWriter {
	upsert(summary: VaultSyncStatusSummary, flushedAt: number): Promise<void>;
}

export class HealthSyncService {
	private scheduledFlushAt: number | null = null;

	constructor(
		private readonly healthStore: HealthStateStore,
		private readonly syncStatusRepository: VaultSyncStatusWriter | null,
		private readonly cursorActiveTtlMs: number,
		private readonly maintenanceScheduler: MaintenanceScheduler,
	) {}

	async scheduleSummaryFlush(now = Date.now()): Promise<void> {
		const flushAt = now + DEFAULT_HEALTH_SUMMARY_FLUSH_DELAY_MS;
		if (this.scheduledFlushAt !== null && this.scheduledFlushAt <= flushAt) {
			return;
		}

		await this.maintenanceScheduler.defer("health_summary_flush", flushAt, now);
		this.scheduledFlushAt = flushAt;
	}

	async flushSummary(
		options: { force?: boolean; now?: number; throwOnError?: boolean } = {},
	): Promise<void> {
		if (!this.syncStatusRepository) {
			return;
		}

		const now = options.now ?? Date.now();
		const summary = this.healthStore.readHealthSummary(now, this.cursorActiveTtlMs);
		if (!summary) {
			return;
		}

		try {
			await this.syncStatusRepository.upsert(summary, now);
			this.healthStore.recordHealthSummaryFlushed(now);
			this.scheduledFlushAt = null;
		} catch (error) {
			this.healthStore.recordHealthSummaryFlushFailed(error, now);
			this.scheduledFlushAt = null;
			if (options.throwOnError) {
				throw error;
			}
			await this.maintenanceScheduler.defer("health_summary_flush", now, now);
		}
	}
}
