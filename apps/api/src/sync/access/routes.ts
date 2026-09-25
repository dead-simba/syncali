import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import type { AuthProvider } from "../../auth";
import type { SyncService } from "./service";
import { Hono } from "hono";
import { createEnsureAuthenticatedSession } from "../../middlewares/authenticated-session";

export function registerSyncAccessRoutes(
	app: Hono,
	deps: { syncService: SyncService; getAuth: AuthProvider },
): void {
	const ensureAuthenticatedSession = createEnsureAuthenticatedSession(deps.getAuth);

	app.post(
		"/v1/sync/token",
		ensureAuthenticatedSession,
		zValidator(
			"json",
			z.object({
				vaultId: z.string().trim().min(1),
				localVaultId: z.string().trim().min(1),
			}),
		),
		async (c) => {
			const body = c.req.valid("json");

			return c.json(
				await deps.syncService.issueSyncToken({ userId: c.var.user.id }, {
					vaultId: body.vaultId,
					localVaultId: body.localVaultId,
				}),
			);
		},
	);
}
