import { createMiddleware } from "hono/factory";

import { getSession, type AuthProvider } from "../auth";
import { apiError } from "../errors";
import { User } from "better-auth/types";

export type AuthenticatedSessionVariables = {
	user: User;
};

export function createEnsureAuthenticatedSession(getAuth: AuthProvider) {
	return createMiddleware<{
		Variables: AuthenticatedSessionVariables;
	}>(async (c, next) => {
		const data = await getSession(getAuth(), c.req.raw);
		if (!data) {
			throw apiError(401, "unauthorized", "authentication required");
		}
		c.set("user", data.user);
		await next();
	});
}
