import { afterEach, describe, expect, it, vi } from "vitest";

import { SyncTokenService } from "../sync/access/token-service";
import { createRuntimeApp, getRuntimeApp } from "./http";

// Wraps the real factory so the tests can count constructions and make one
// fail, while every auth request still goes through real Better Auth.
const authFactory = vi.hoisted(() => ({
	createAuth: undefined as unknown as ReturnType<typeof vi.fn>,
}));
vi.mock("../auth/factory", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../auth/factory")>();
	authFactory.createAuth = vi.fn(actual.createAuth);
	return { ...actual, createAuth: authFactory.createAuth };
});

const SYNC_TOKEN_SECRET = "runtime-test-sync-secret";

type TestEnv = Parameters<typeof getRuntimeApp>[0];

afterEach(() => {
	authFactory.createAuth.mockClear();
});

// Each call returns a new object, which is what a fresh isolate looks like to
// the cache: it is keyed on the env object workerd hands to `fetch`.
function managedEnv(overrides: Record<string, unknown> = {}): TestEnv {
	return {
		DB: {},
		SYNC_BLOBS: {
			get: vi.fn(async () => ({
				body: new Response("ciphertext").body,
				size: "ciphertext".length,
			})),
		},
		SYNC_COORDINATOR: {
			getByName: vi.fn(() => ({
				fetch: vi.fn(async () => new Response(null, { status: 204 })),
			})),
		},
		SYNC_TOKEN_SECRET,
		BETTER_AUTH_SECRET: "runtime-test-better-auth-secret",
		EMAIL: { send: vi.fn() },
		AUTH_EMAIL_FROM: "Synch <noreply@example.test>",
		WWW_BASE_URL: "https://www.example.test",
		SELF_HOSTED: false,
		VAULT_PURGE_QUEUE: { send: vi.fn() },
		...overrides,
	} as unknown as TestEnv;
}

function selfHostedEnv(overrides: Record<string, unknown> = {}): TestEnv {
	return managedEnv({
		SELF_HOSTED: true,
		VAULT_PURGE_QUEUE: undefined,
		AUTH_ALLOWED_EMAILS: "you@example.test",
		...overrides,
	});
}

async function blobDownloadRequest(origin = "https://api.example.test"): Promise<Request> {
	const now = Math.floor(Date.now() / 1000);
	const token = await new SyncTokenService(SYNC_TOKEN_SECRET).signSyncToken({
		sub: "user-1",
		vaultId: "vault-1",
		localVaultId: "local-vault-1",
		scope: "vault:sync",
		iat: now,
		exp: now + 60,
	});
	return new Request(`${origin}/v1/vaults/vault-1/blobs/blob-1`, {
		headers: { authorization: `Bearer ${token}` },
	});
}

describe("HTTP runtime reuse", () => {
	it("reuses one app across requests for the same env and auth base URL", () => {
		const env = managedEnv({ BETTER_AUTH_URL: "https://api.example.test" });

		const first = getRuntimeApp(env, new Request("https://api.example.test/health"));
		const second = getRuntimeApp(env, new Request("https://api.example.test/v1/vaults"));
		// With BETTER_AUTH_URL set, the request host does not change the auth
		// base URL, so a different Host header still shares the app.
		const otherHost = getRuntimeApp(env, new Request("https://other.example.test/health"));

		expect(second).toBe(first);
		expect(otherHost).toBe(first);
	});

	it("builds a separate app for each auth base URL when BETTER_AUTH_URL is unset", () => {
		const env = selfHostedEnv();

		const a = getRuntimeApp(env, new Request("https://a.example.test/health"));
		const aAgain = getRuntimeApp(env, new Request("https://a.example.test/v1/vaults"));
		const b = getRuntimeApp(env, new Request("https://b.example.test/health"));

		expect(aAgain).toBe(a);
		expect(b).not.toBe(a);
	});

	it("keeps only a handful of apps per env, dropping the oldest", () => {
		const env = selfHostedEnv();
		const first = getRuntimeApp(env, new Request("https://host-0.example.test/"));
		for (let i = 1; i <= 8; i += 1) {
			getRuntimeApp(env, new Request(`https://host-${i}.example.test/`));
		}
		const newest = getRuntimeApp(env, new Request("https://host-8.example.test/"));

		expect(getRuntimeApp(env, new Request("https://host-8.example.test/"))).toBe(newest);
		expect(getRuntimeApp(env, new Request("https://host-0.example.test/"))).not.toBe(first);
	});

	it("does not cache a runtime whose construction failed", async () => {
		const env = selfHostedEnv({ AUTH_ALLOWED_EMAILS: undefined });
		const request = new Request("https://api.example.test/health");

		expect(() => getRuntimeApp(env, request)).toThrow("AUTH_ALLOWED_EMAILS binding is required");

		(env as unknown as { AUTH_ALLOWED_EMAILS: string }).AUTH_ALLOWED_EMAILS = "you@example.test";
		const response = await getRuntimeApp(env, request).fetch(request);

		expect(response.status).toBe(200);
	});

	it("fails every request on a managed deploy missing its email settings", async () => {
		// Better Auth checks these when it is built, and it is now built only
		// for the requests that need it. Checked up front, a deploy missing one
		// still fails as a whole, as it did before, instead of serving uploads
		// while nobody can sign in.
		const request = await blobDownloadRequest();

		expect(() => getRuntimeApp(managedEnv({ EMAIL: undefined }), request)).toThrow(
			"Cloudflare Email Service binding EMAIL is required",
		);
		expect(() => getRuntimeApp(managedEnv({ AUTH_EMAIL_FROM: undefined }), request)).toThrow(
			"AUTH_EMAIL_FROM is required",
		);
		expect(authFactory.createAuth).not.toHaveBeenCalled();
	});

	it("keeps createRuntimeApp building a fresh app on every call", () => {
		const env = managedEnv();
		const request = new Request("https://api.example.test/health");

		expect(createRuntimeApp(env, request)).not.toBe(createRuntimeApp(env, request));
	});
});

describe("HTTP runtime Better Auth construction", () => {
	it("serves a blob request on a fresh isolate without building Better Auth", async () => {
		const env = managedEnv();
		const request = await blobDownloadRequest();

		const response = await getRuntimeApp(env, request).fetch(request);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ciphertext");
		expect(authFactory.createAuth).not.toHaveBeenCalled();
	});

	it("builds Better Auth once, on the first request that needs it", async () => {
		const env = managedEnv();
		const blob = await blobDownloadRequest();
		const app = getRuntimeApp(env, blob);
		await app.fetch(blob);
		expect(authFactory.createAuth).not.toHaveBeenCalled();

		const ok = new Request("https://api.example.test/api/auth/ok");
		const okResponse = await getRuntimeApp(env, ok).fetch(ok);
		const vaults = new Request("https://api.example.test/v1/vaults");
		const vaultsResponse = await getRuntimeApp(env, vaults).fetch(vaults);

		expect(okResponse.status).toBe(200);
		expect(await okResponse.json()).toEqual({ ok: true });
		// No session cookie or bearer token, so the session middleware must
		// still turn the request away exactly as it did before.
		expect(vaultsResponse.status).toBe(401);
		expect(await vaultsResponse.json()).toEqual({
			error: "unauthorized",
			message: "authentication required",
		});
		expect(authFactory.createAuth).toHaveBeenCalledTimes(1);
		expect(authFactory.createAuth).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				baseURL: "https://api.example.test",
				trustedOrigins: ["https://api.example.test", "https://www.example.test"],
			}),
		);
	});

	it("retries Better Auth construction after a failure instead of caching it", async () => {
		const env = managedEnv();
		authFactory.createAuth.mockImplementationOnce(() => {
			throw new Error("simulated Better Auth construction failure");
		});
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			const failing = new Request("https://api.example.test/api/auth/ok");
			const failed = await getRuntimeApp(env, failing).fetch(failing);
			const retry = new Request("https://api.example.test/api/auth/ok");
			const retried = await getRuntimeApp(env, retry).fetch(retry);

			expect(failed.status).toBe(500);
			expect(await failed.json()).toEqual({
				error: "internal_error",
				message: "unexpected server error",
			});
			expect(retried.status).toBe(200);
			expect(authFactory.createAuth).toHaveBeenCalledTimes(2);
		} finally {
			consoleError.mockRestore();
		}
	});

	it("retries Better Auth construction when its setup fails after it returned", async () => {
		const env = managedEnv();
		// Real Better Auth returns straight away and finishes setting up in
		// `$context`; a bad secret rejects there instead of throwing. This
		// stand-in behaves the same way.
		authFactory.createAuth.mockImplementationOnce(() => {
			const setup = Promise.reject(new Error("simulated Better Auth setup failure"));
			return {
				$context: setup,
				handler: async () => {
					await setup;
				},
			};
		});
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			const failing = new Request("https://api.example.test/api/auth/ok");
			const failed = await getRuntimeApp(env, failing).fetch(failing);
			const retry = new Request("https://api.example.test/api/auth/ok");
			const retried = await getRuntimeApp(env, retry).fetch(retry);

			expect(failed.status).toBe(500);
			expect(retried.status).toBe(200);
			expect(await retried.json()).toEqual({ ok: true });
			expect(authFactory.createAuth).toHaveBeenCalledTimes(2);
		} finally {
			consoleError.mockRestore();
		}
	});
});
