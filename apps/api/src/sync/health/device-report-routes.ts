import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import type { SyncTokenService } from "../access/token-service";
import type { DeviceReportStore } from "./device-report-repository";

const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Encrypted details: file names and error text, opaque to the server. */
export const MAX_DEVICE_REPORT_DETAILS_LENGTH = 128 * 1024;
const MAX_DEVICE_REPORT_BODY_BYTES = MAX_DEVICE_REPORT_DETAILS_LENGTH + 16 * 1024;

const counter = z.number().int().min(0).max(1_000_000_000);
const timestamp = z.number().int().min(0).max(10_000_000_000_000);
const code = z.string().regex(/^[a-z_]{0,32}$/);
const version = z.string().regex(/^[0-9A-Za-z.+-]{0,32}$/);

/**
 * The readable half of a device report. Every field is a number, a timestamp
 * or a short code - nothing that can carry a file name or an error message -
 * and unknown fields are dropped rather than stored, so whatever a client
 * sends, the server keeps only what it knows to be free of note content.
 */
export const deviceReportSchema = z.object({
	schema: z.literal(1),
	generatedAt: timestamp,
	platform: z.enum(["android", "ios", "macos", "windows", "linux", "unknown"]),
	mobile: z.boolean(),
	pluginVersion: version.min(1),
	obsidianVersion: version,
	status: code,
	cursor: counter,
	serverCursor: counter.nullable(),
	activeSince: timestamp.nullable(),
	lastSyncOkAt: timestamp.nullable(),
	lastErrorAt: timestamp.nullable(),
	pendingUploads: counter,
	setAside: counter,
	skippedUnreadable: counter,
	problems: z
		.record(
			z.string().regex(/^[a-z_]{1,32}$/),
			z.object({ count: counter, firstAt: timestamp, lastAt: timestamp }),
		)
		.refine((problems) => Object.keys(problems).length <= 16, "too many problem kinds"),
	files: z
		.object({
			count: counter,
			digest: z.string().regex(/^[0-9a-f]{64}$/),
		})
		.nullable(),
	rules: z.object({
		images: z.boolean(),
		audio: z.boolean(),
		videos: z.boolean(),
		pdf: z.boolean(),
		other: z.boolean(),
		excludedFolders: counter,
	}),
});

export type DeviceReport = z.infer<typeof deviceReportSchema>;

const putBodySchema = z.object({
	report: deviceReportSchema,
	details: z.string().max(MAX_DEVICE_REPORT_DETAILS_LENGTH).nullable(),
});

export function registerDeviceReportRoutes(
	app: Hono,
	deps: {
		syncTokenService: SyncTokenService;
		deviceReportRepository: DeviceReportStore;
		now?: () => number;
	},
): void {
	const now = deps.now ?? (() => Date.now());
	const vaultParam = zValidator(
		"param",
		z.object({ vaultId: z.string().trim().min(1).regex(SAFE_ID_PATTERN) }),
	);

	// A device writes only its own report: which device it is comes from the
	// sync token, never from the request body.
	app.put(
		"/v1/vaults/:vaultId/device-report",
		vaultParam,
		bodyLimit({
			maxSize: MAX_DEVICE_REPORT_BODY_BYTES,
			onError: (c) =>
				c.json({ error: "payload_too_large", message: "device report is too large" }, 413),
		}),
		zValidator("json", putBodySchema),
		async (c) => {
			const { vaultId } = c.req.valid("param");
			const claims = await deps.syncTokenService.requireSyncToken(c.req.raw, vaultId);
			const body = c.req.valid("json");

			await deps.deviceReportRepository.upsert({
				vaultId,
				localVaultId: claims.localVaultId,
				userId: claims.sub,
				platform: body.report.platform,
				pluginVersion: body.report.pluginVersion,
				reportJson: JSON.stringify(body.report),
				detailsEnvelope: body.details,
				reportedAt: now(),
			});

			return c.body(null, 204);
		},
	);

	// Any device syncing the vault may read every device's report: they share
	// the vault key, so the encrypted details are theirs to read too.
	app.get("/v1/vaults/:vaultId/device-reports", vaultParam, async (c) => {
		const { vaultId } = c.req.valid("param");
		const claims = await deps.syncTokenService.requireSyncToken(c.req.raw, vaultId);
		const records = await deps.deviceReportRepository.listForVault(vaultId);

		return c.json({
			reports: records.map((record) => ({
				localVaultId: record.localVaultId,
				isRequestingDevice: record.localVaultId === claims.localVaultId,
				reportedAt: record.reportedAt,
				report: parseStoredReport(record.reportJson),
				details: record.detailsEnvelope,
			})),
		});
	});
}

function parseStoredReport(reportJson: string): unknown {
	try {
		return JSON.parse(reportJson) as unknown;
	} catch {
		return null;
	}
}
