import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { apiError, onError } from "../../errors";
import type { SyncTokenService } from "../access/token-service";
import type { DeviceReportRecord, DeviceReportStore } from "./device-report-repository";
import { MAX_DEVICE_REPORT_DETAILS_LENGTH, registerDeviceReportRoutes } from "./device-report-routes";

class MemoryDeviceReportStore implements DeviceReportStore {
	readonly rows = new Map<string, DeviceReportRecord>();

	async upsert(record: DeviceReportRecord): Promise<void> {
		this.rows.set(`${record.vaultId}/${record.localVaultId}`, record);
	}

	async listForVault(vaultId: string): Promise<DeviceReportRecord[]> {
		return [...this.rows.values()].filter((row) => row.vaultId === vaultId);
	}
}

// "Bearer <localVaultId>@<vaultId>" stands in for a signed sync token.
const tokenService = {
	async requireSyncToken(request: Request, expectedVaultId?: string) {
		const [localVaultId, vaultId] = (request.headers.get("authorization") ?? "")
			.replace(/^Bearer /, "")
			.split("@");
		if (!localVaultId || !vaultId) {
			throw apiError(401, "unauthorized", "missing sync token");
		}
		if (expectedVaultId && vaultId !== expectedVaultId) {
			throw apiError(403, "forbidden", "vault mismatch");
		}
		return {
			sub: "user-1",
			vaultId,
			localVaultId,
			scope: "vault:sync" as const,
			iat: 0,
			exp: 0,
		};
	},
} as unknown as SyncTokenService;

function buildApp() {
	const store = new MemoryDeviceReportStore();
	const app = new Hono();
	registerDeviceReportRoutes(app, {
		syncTokenService: tokenService,
		deviceReportRepository: store,
		now: () => 1_794_220_000_000,
	});
	app.onError(onError);
	return { app, store };
}

function report(overrides: Record<string, unknown> = {}) {
	return {
		schema: 1,
		generatedAt: 1_794_219_999_000,
		platform: "android",
		mobile: true,
		pluginVersion: "0.3.29",
		obsidianVersion: "1.15.0",
		status: "attention_needed",
		cursor: 13_100,
		serverCursor: 13_902,
		activeSince: 1_794_210_000_000,
		lastSyncOkAt: 1_793_000_000_000,
		lastErrorAt: 1_794_219_000_000,
		pendingUploads: 2,
		setAside: 0,
		skippedUnreadable: 1,
		problems: {
			name_refused: { count: 1400, firstAt: 1_793_000_000_000, lastAt: 1_794_219_000_000 },
		},
		files: { count: 1590, digest: "a".repeat(64) },
		rules: { images: true, audio: true, videos: false, pdf: true, other: true, excludedFolders: 0 },
		...overrides,
	};
}

function put(app: Hono, token: string, body: unknown, vaultId = "vault-1") {
	return app.request(`/v1/vaults/${vaultId}/device-report`, {
		method: "PUT",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("device report routes", () => {
	it("stores a report under the device named by the sync token", async () => {
		const { app, store } = buildApp();

		const response = await put(app, "phone@vault-1", {
			report: report(),
			details: '{"version":1,"nonce":"n","ciphertext":"c"}',
		});

		expect(response.status).toBe(204);
		const row = store.rows.get("vault-1/phone");
		expect(row).toMatchObject({
			localVaultId: "phone",
			userId: "user-1",
			platform: "android",
			pluginVersion: "0.3.29",
			reportedAt: 1_794_220_000_000,
			detailsEnvelope: '{"version":1,"nonce":"n","ciphertext":"c"}',
		});
		expect(JSON.parse(row?.reportJson ?? "{}")).toEqual(report());
	});

	it("cannot be pointed at another device or another vault", async () => {
		const { app, store } = buildApp();

		// The body has no say in which device this is.
		await put(app, "phone@vault-1", { report: report(), details: null, localVaultId: "laptop" });
		expect([...store.rows.keys()]).toEqual(["vault-1/phone"]);

		const otherVault = await put(app, "phone@vault-1", { report: report(), details: null }, "vault-2");
		expect(otherVault.status).toBe(403);
	});

	it("keeps nothing in the readable part that could name a file", async () => {
		const { app, store } = buildApp();

		// Fields it does not know are dropped, not stored.
		await put(app, "phone@vault-1", {
			report: { ...report(), lastProblemPath: "Journal/private.md" },
			details: null,
		});
		expect(store.rows.get("vault-1/phone")?.reportJson).not.toContain("Journal");

		// Free text is refused in fields that only ever hold codes.
		for (const bad of [
			report({ status: "write failed for Journal/private.md" }),
			report({ problems: { "Journal/private.md": { count: 1, firstAt: 1, lastAt: 1 } } }),
			report({ pluginVersion: "0.3.29 Journal/private.md" }),
		]) {
			const response = await put(app, "laptop@vault-1", { report: bad, details: null });
			expect(response.status).toBe(400);
		}
		expect(store.rows.has("vault-1/laptop")).toBe(false);
	});

	it("refuses details larger than the limit", async () => {
		const { app } = buildApp();

		const response = await put(app, "phone@vault-1", {
			report: report(),
			details: "x".repeat(MAX_DEVICE_REPORT_DETAILS_LENGTH + 1),
		});

		expect([400, 413]).toContain(response.status);
	});

	it("requires a sync token", async () => {
		const { app } = buildApp();

		const response = await app.request("/v1/vaults/vault-1/device-reports");

		expect(response.status).toBe(401);
	});

	it("lists every device's report for the vault, and says which one is asking", async () => {
		const { app } = buildApp();
		await put(app, "phone@vault-1", { report: report(), details: "envelope-phone" });
		await put(app, "laptop@vault-1", {
			report: report({ platform: "macos", mobile: false }),
			details: null,
		});
		await put(app, "elsewhere@vault-2", { report: report(), details: null }, "vault-2");

		const response = await app.request("/v1/vaults/vault-1/device-reports", {
			headers: { authorization: "Bearer laptop@vault-1" },
		});
		const body = (await response.json()) as {
			reports: Array<{ localVaultId: string; isRequestingDevice: boolean; details: string | null }>;
		};

		expect(response.status).toBe(200);
		expect(
			body.reports
				.map((entry) => [entry.localVaultId, entry.isRequestingDevice, entry.details])
				.sort(),
		).toEqual([
			["laptop", true, null],
			["phone", false, "envelope-phone"],
		]);
	});
});
