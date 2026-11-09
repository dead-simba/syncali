import { and, desc, eq } from "drizzle-orm";

import type { AppDb } from "../../db/client";
import { vaultDeviceReport } from "../../db/d1/vault-schema";

export type DeviceReportRecord = {
	vaultId: string;
	localVaultId: string;
	userId: string;
	platform: string;
	pluginVersion: string;
	reportJson: string;
	detailsEnvelope: string | null;
	reportedAt: number;
};

export interface DeviceReportStore {
	upsert(record: DeviceReportRecord): Promise<void>;
	listForVault(vaultId: string): Promise<DeviceReportRecord[]>;
}

/**
 * One row per device per vault, replaced on every report. A history would
 * grow without bound on a free-tier database; the latest report plus the
 * counters inside it (first seen, last seen, count) carry what a history
 * would be read for.
 */
export class DeviceReportRepository implements DeviceReportStore {
	constructor(private readonly db: AppDb) {}

	async upsert(record: DeviceReportRecord): Promise<void> {
		await this.db
			.insert(vaultDeviceReport)
			.values({
				...record,
				createdAt: record.reportedAt,
				updatedAt: record.reportedAt,
			})
			.onConflictDoUpdate({
				target: [vaultDeviceReport.vaultId, vaultDeviceReport.localVaultId],
				set: {
					userId: record.userId,
					platform: record.platform,
					pluginVersion: record.pluginVersion,
					reportJson: record.reportJson,
					detailsEnvelope: record.detailsEnvelope,
					reportedAt: record.reportedAt,
					updatedAt: record.reportedAt,
				},
			});
	}

	async listForVault(vaultId: string): Promise<DeviceReportRecord[]> {
		const rows = await this.db
			.select()
			.from(vaultDeviceReport)
			.where(and(eq(vaultDeviceReport.vaultId, vaultId)))
			.orderBy(desc(vaultDeviceReport.reportedAt));

		return rows.map((row) => ({
			vaultId: row.vaultId,
			localVaultId: row.localVaultId,
			userId: row.userId,
			platform: row.platform,
			pluginVersion: row.pluginVersion,
			reportJson: row.reportJson,
			detailsEnvelope: row.detailsEnvelope,
			reportedAt: row.reportedAt,
		}));
	}
}
