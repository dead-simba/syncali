import { env, exports as workerExports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";

import { createRuntimeApp } from "../../src/runtime";

type JsonRequestResult<T> = {
	response: Response;
	json: T | null;
	text: string;
};

type AccountFixture = {
	email: string;
	password: string;
	sessionCookie: string;
	userId: string;
};

type VaultFixture = AccountFixture & {
	vaultId: string;
	organizationId: string;
	vaultName: string;
};

export const DEFAULT_VAULT_WRAPPER = {
	kind: "password" as const,
	envelope: {
		version: 1,
		keyVersion: 1,
		kdf: {
			name: "argon2id",
			memoryKiB: 65_536,
			iterations: 3,
			parallelism: 1,
			salt: "MDEyMzQ1Njc4OWFiY2RlZg==",
		},
		wrap: {
			algorithm: "aes-256-gcm",
			nonce: "AAECAwQFBgcICQoL",
			ciphertext:
				"c3luY2h2YXVsdC13cmFwcGVkLXZhdWx0LWtleS12MS10ZXN0LWNpcGhlcnRleHQh",
		},
	},
};

type CoordinatorStateLimits = {
	storageLimitBytes?: number;
	maxFileSizeBytes?: number;
	versionHistoryRetentionDays?: number;
};

const DEFAULT_COORDINATOR_STATE_LIMITS = {
	storageLimitBytes: 1_000_000_000,
	maxFileSizeBytes: 10_000_000,
	versionHistoryRetentionDays: 1,
};

export async function initializeCoordinatorState(
	vaultId: string,
	limits: CoordinatorStateLimits = {},
): Promise<void> {
	const resolvedLimits = {
		...DEFAULT_COORDINATOR_STATE_LIMITS,
		...limits,
	};
	const stub = env.SYNC_COORDINATOR.getByName(vaultId);
	await runInDurableObject(stub, async (_instance, state) => {
		state.storage.sql.exec(
			`
			INSERT INTO coordinator_state (
				id,
				vault_id,
				storage_limit_bytes,
				max_file_size_bytes,
				version_history_retention_days
			)
			VALUES (1, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				vault_id = excluded.vault_id,
				storage_limit_bytes = excluded.storage_limit_bytes,
				max_file_size_bytes = excluded.max_file_size_bytes,
				version_history_retention_days = excluded.version_history_retention_days
			`,
			vaultId,
			resolvedLimits.storageLimitBytes,
			resolvedLimits.maxFileSizeBytes,
			resolvedLimits.versionHistoryRetentionDays,
		);
	});
}

type IssueTokenResponse = {
	token: string;
	expiresAt: number;
	vaultId: string;
	localVaultId: string;
	syncFormatVersion: number;
};

const TEST_ORIGIN = process.env.BETTER_AUTH_URL;
const DEFAULT_PASSWORD = "supersecret123";

export function uniqueId(prefix: string): string {
	return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

export async function apiRequest(path: string, init: RequestInit = {}): Promise<Response> {
	const url = new URL(path, TEST_ORIGIN);
	const headers = new Headers(init.headers ?? {});

	if (!headers.has("origin")) {
		headers.set("origin", url.origin);
	}
	if (!headers.has("referer")) {
		headers.set("referer", `${url.origin}/`);
	}

	const request = new Request(url.toString(), {
		...init,
		headers,
	});
	return await workerExports.default.fetch(request);
}

export async function jsonRequest<T = unknown>(
	path: string,
	init: RequestInit = {},
): Promise<JsonRequestResult<T>> {
	const response = await apiRequest(path, init);
	const text = await response.text();

	return {
		response,
		text,
		json: parseJson<T>(text),
	};
}

export async function signUpAccount(
	overrides: Partial<{ email: string; password: string; name: string }> = {},
): Promise<AccountFixture> {
	const email = overrides.email ?? `${uniqueId("sync-e2e")}@test.invalid`;
	const password = overrides.password ?? DEFAULT_PASSWORD;
	const name = overrides.name ?? "Synch Vitest";
	const selfHostedTestEnv = {
		...env,
		SELF_HOSTED: true,
		AUTH_ALLOWED_EMAILS: email,
	};

	const signUp = await jsonRequestWithEnv(
		"/api/auth/sign-up/email",
		selfHostedTestEnv,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify({ email, password, name }),
		},
	);
	assertOk(signUp.response, "sign-up");

	const sessionCookie = extractCookieHeader(signUp.response);
	if (!sessionCookie) {
		throw new Error("sign-up did not return a session cookie");
	}

	const session = await jsonRequestWithEnv<{ user: { id: string } }>(
		"/api/auth/get-session",
		selfHostedTestEnv,
		{
			headers: {
				cookie: sessionCookie,
			},
		},
	);
	assertOk(session.response, "get-session");

	const userId = session.json?.user?.id;
	if (!userId) {
		throw new Error("authenticated session is missing user id");
	}

	return {
		email,
		password,
		sessionCookie,
		userId,
	};
}

export async function signUpAndCreateVault(
	vaultName = uniqueId("vault"),
): Promise<VaultFixture> {
	const account = await signUpAccount();

	const createdVault = await jsonRequest<{
		vault: { id: string; organizationId: string; name: string };
	}>("/v1/vaults", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			cookie: account.sessionCookie,
		},
		body: JSON.stringify({ name: vaultName, initialWrapper: DEFAULT_VAULT_WRAPPER }),
	});
	assertStatus(createdVault.response, 201, 299, "create-vault");

	const createdVaultId = createdVault.json?.vault?.id;
	if (!createdVaultId) {
		throw new Error("create-vault response is missing vault id");
	}
	const organizationId = createdVault.json?.vault?.organizationId;
	if (!organizationId) {
		throw new Error("create-vault response is missing organization id");
	}

	return {
		...account,
		vaultId: createdVaultId,
		organizationId,
		vaultName,
	};
}

export async function issueSyncToken(
	sessionCookie: string,
	vaultId: string,
	localVaultId: string,
): Promise<IssueTokenResponse> {
	const issued = await jsonRequest<IssueTokenResponse>("/v1/sync/token", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			cookie: sessionCookie,
		},
		body: JSON.stringify({ vaultId, localVaultId }),
	});
	assertOk(issued.response, "issue-sync-token");

	if (!issued.json?.token) {
		throw new Error("sync token response is missing token");
	}
	if (issued.json.syncFormatVersion !== 2) {
		throw new Error("sync token response has an unexpected sync format version");
	}

	return issued.json;
}

export function extractCookieHeader(response: Response): string {
	const cookie = response.headers.get("set-cookie");
	return cookie?.split(";")[0]?.trim() ?? "";
}

async function jsonRequestWithEnv<T = unknown>(
	path: string,
	testEnv: Env & { EMAIL?: SendEmail; AUTH_EMAIL_FROM?: string },
	init: RequestInit = {},
): Promise<JsonRequestResult<T>> {
	const response = await apiRequestWithEnv(path, testEnv, init);
	const text = await response.text();

	return {
		response,
		text,
		json: parseJson<T>(text),
	};
}

async function apiRequestWithEnv(
	path: string,
	testEnv: Env & { EMAIL?: SendEmail; AUTH_EMAIL_FROM?: string },
	init: RequestInit = {},
): Promise<Response> {
	const url = new URL(path, TEST_ORIGIN);
	const headers = new Headers(init.headers ?? {});

	if (!headers.has("origin")) {
		headers.set("origin", url.origin);
	}
	if (!headers.has("referer")) {
		headers.set("referer", `${url.origin}/`);
	}

	const request = new Request(url.toString(), {
		...init,
		headers,
	});

	return await createRuntimeApp(testEnv, request).fetch(request);
}

function assertOk(response: Response, label: string): void {
	assertStatus(response, 200, 299, label);
}

function assertStatus(response: Response, min: number, max: number, label: string): void {
	if (response.status < min || response.status > max) {
		throw new Error(`${label} failed with status ${response.status}`);
	}
}

function parseJson<T>(text: string): T | null {
	if (!text) {
		return null;
	}

	try {
		return JSON.parse(text) as T;
	} catch {
		return null;
	}
}
