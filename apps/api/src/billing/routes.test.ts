import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
	getSession: vi.fn(),
}));

vi.mock("../auth", () => ({
	getSession: authMocks.getSession,
}));

import type { Auth } from "../auth";
import { apiError, onError } from "../errors";
import { registerBillingRoutes } from "./routes";
import type { BillingService } from "./service";

describe("billing routes", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("requires authentication for customer portal sessions", async () => {
		authMocks.getSession.mockResolvedValueOnce(null);
		const app = createTestApp();

		const response = await app.request("/v1/billing/portal", {
			method: "POST",
		});

		expect(response.status).toBe(401);
		await expect(response.json()).resolves.toMatchObject({
			error: "unauthorized",
		});
	});

	it("creates customer portal sessions for authenticated users", async () => {
		authMocks.getSession.mockResolvedValueOnce({
			user: {
				id: "user-1",
				email: "user@example.com",
			},
		});
		const billingService = fakeBillingService();
		const app = createTestApp(billingService);

		const response = await app.request("/v1/billing/portal", {
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify({
				returnPath: "/ko/billing",
			}),
		});

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			url: "https://polar.example/portal",
		});
		expect(billingService.createCustomerPortalSession).toHaveBeenCalledWith(
			"user-1",
			"/ko/billing",
		);
	});

	it("returns not found when a billing customer is missing", async () => {
		authMocks.getSession.mockResolvedValueOnce({
			user: {
				id: "user-1",
				email: "user@example.com",
			},
		});
		const billingService = fakeBillingService({
			createCustomerPortalSession: vi.fn(() => {
				throw apiError(
					404,
					"billing_customer_not_found",
					"billing customer was not found",
				);
			}),
		});
		const app = createTestApp(billingService);

		const response = await app.request("/v1/billing/portal", {
			method: "POST",
		});

		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toMatchObject({
			error: "billing_customer_not_found",
		});
	});
});

function createTestApp(billingService = fakeBillingService()): Hono {
	const app = new Hono();
	registerBillingRoutes(app, {
		getAuth: () => ({}) as Auth,
		billingService,
	});
	app.onError(onError);
	return app;
}

function fakeBillingService(overrides: Partial<BillingService> = {}): BillingService {
	return {
		createCheckout: vi.fn(),
		readBillingStatus: vi.fn(),
		createCustomerPortalSession: vi.fn(async () => ({
			url: "https://polar.example/portal",
		})),
		...overrides,
	} as unknown as BillingService;
}
