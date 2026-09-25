import { Hono } from "hono";
import { z } from "zod";

import type { AuthProvider } from "../auth";
import { apiError } from "../errors";
import { createEnsureAuthenticatedSession } from "../middlewares/authenticated-session";
import {
	SUBSCRIPTION_BILLING_INTERVALS,
	SUBSCRIPTION_PLAN_IDS,
	type SubscriptionBillingInterval,
	type SubscriptionPlanId,
} from "../subscription/policy";
import type { BillingService } from "./service";

const checkoutRequestSchema = z.object({
	billingInterval: z.enum(SUBSCRIPTION_BILLING_INTERVALS).optional(),
	planId: z.enum(SUBSCRIPTION_PLAN_IDS).optional(),
}).strict();

const portalRequestSchema = z.object({
	returnPath: z.string().optional(),
}).strict();

export function registerBillingRoutes(
	app: Hono,
	deps: { getAuth: AuthProvider; billingService: BillingService },
): void {
	const ensureAuthenticatedSession = createEnsureAuthenticatedSession(deps.getAuth);

	app.post("/v1/billing/checkout", ensureAuthenticatedSession, async (c) => {
		const user = c.var.user;
		const { billingInterval, planId } = await readCheckoutRequestPlanId(c.req.raw);
		const checkout = await deps.billingService.createCheckout({
			userId: user.id,
			email: user.email,
			planId,
			billingInterval,
		});

		return c.json(checkout);
	});

	app.get("/v1/billing/status", ensureAuthenticatedSession, async (c) => {
		const user = c.var.user;
		const status = await deps.billingService.readBillingStatus(user.id);

		return c.json(status);
	});

	app.post("/v1/billing/portal", ensureAuthenticatedSession, async (c) => {
		const user = c.var.user;
		const returnPath = await readPortalRequestReturnPath(c.req.raw);
		const portal = await deps.billingService.createCustomerPortalSession(
			user.id,
			returnPath,
		);

		return c.json(portal);
	});
}

async function readPortalRequestReturnPath(request: Request): Promise<string> {
	if (!request.headers.get("content-type")) {
		return "/billing";
	}

	let json: unknown;
	try {
		json = await request.json();
	} catch {
		throw apiError(400, "bad_request", "invalid billing portal request");
	}

	const parsed = portalRequestSchema.safeParse(json);
	if (!parsed.success) {
		throw apiError(400, "bad_request", "invalid billing portal request");
	}

	const returnPath = parsed.data.returnPath ?? "/billing";
	if (!returnPath.startsWith("/") || returnPath.startsWith("//")) {
		throw apiError(400, "bad_request", "invalid billing portal return path");
	}

	return returnPath;
}

async function readCheckoutRequestPlanId(request: Request): Promise<{
	billingInterval: SubscriptionBillingInterval;
	planId: SubscriptionPlanId;
}> {
	if (!request.headers.get("content-type")) {
		return { planId: "starter", billingInterval: "monthly" };
	}

	let json: unknown;
	try {
		json = await request.json();
	} catch {
		throw apiError(400, "bad_request", "invalid checkout request");
	}

	const parsed = checkoutRequestSchema.safeParse(json);
	if (!parsed.success) {
		throw apiError(400, "bad_request", "invalid checkout request");
	}

	return {
		planId: parsed.data.planId ?? "starter",
		billingInterval: parsed.data.billingInterval ?? "monthly",
	};
}
