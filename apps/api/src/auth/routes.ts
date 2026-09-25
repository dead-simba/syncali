import { Hono } from "hono";

import { normalizeDeviceAuthorizationRequest } from "./device";
import type { AuthProvider } from "./factory";
import { normalizeBearerSessionRequest } from "./session";

export function registerAuthRoutes(app: Hono, getAuth: AuthProvider): void {
	app.get("/verify-email", (c) => {
		const url = new URL(c.req.url);
		url.pathname = "/api/auth/verify-email";
		return getAuth().handler(new Request(url.toString(), c.req.raw));
	});
	app.all("/api/auth/*", (c) =>
		getAuth().handler(
			normalizeDeviceAuthorizationRequest(normalizeBearerSessionRequest(c.req.raw)),
		),
	);
}
