import { WebSocket } from "ws";

const DEFAULT_BASE_URL = "http://127.0.0.1:8787";
const DEFAULT_PASSWORD = "supersecret123";
const REQUEST_TIMEOUT_MS = 10_000;

async function main() {
	const baseUrl = normalizeBaseUrl(process.env.SYNC_E2E_BASE_URL ?? DEFAULT_BASE_URL);
	const uniqueSuffix = Date.now().toString(36);
	const email = process.env.SYNC_E2E_EMAIL ?? `sync-e2e-${uniqueSuffix}@example.com`;
	const password = process.env.SYNC_E2E_PASSWORD ?? DEFAULT_PASSWORD;
	const name = process.env.SYNC_E2E_NAME ?? "Synch E2E";
	const vaultName = process.env.SYNC_E2E_VAULT_NAME ?? `vault-e2e-${uniqueSuffix}`;

	console.log(`baseUrl=${baseUrl}`);
	console.log(`email=${email}`);
	console.log(`vaultName=${vaultName}`);

	const primaryAccount = await signUpAndCreateVault(baseUrl, {
		email,
		name,
		password,
		vaultName,
	});
	const { vaultId } = primaryAccount;
	const tokenA = await issueSyncToken(
		baseUrl,
		primaryAccount.sessionCookie,
		vaultId,
		"local-vault-a",
	);
	const tokenB = await issueSyncToken(
		baseUrl,
		primaryAccount.sessionCookie,
		vaultId,
		"local-vault-b",
	);

	// The coordinator only materializes vault state when a socket connects
	// (VaultLifecycleService.ensureVaultState via SocketConnectionService), so the
	// blob upload has to come after the sockets or stageBlob rejects the fresh
	// vault with sync_state_uninitialized (409).
	const socketA = await openSocket(socketUrl(baseUrl, vaultId), tokenA.token);
	const socketB = await openSocket(socketUrl(baseUrl, vaultId), tokenB.token);

	const blobId = `blob-smoke-${uniqueSuffix}`;
	const blobBytes = new TextEncoder().encode("smoke blob bytes");
	const uploaded = await fetch(`${baseUrl}/v1/vaults/${encodeURIComponent(vaultId)}/blobs/${blobId}`, {
		method: "PUT",
		headers: {
			authorization: `Bearer ${tokenA.token}`,
			"x-blob-size": String(blobBytes.byteLength),
		},
		body: blobBytes,
	});
	assert(uploaded.ok, `blob upload failed: ${uploaded.status}`);

	const helloA = await sendSocketRequest(
		socketA,
		{
			type: "hello",
			requestId: `hello-a-${uniqueSuffix}`,
			lastKnownCursor: 0,
		},
		"hello_ack",
	);
	const helloB = await sendSocketRequest(
		socketB,
		{
			type: "hello",
			requestId: `hello-b-${uniqueSuffix}`,
			lastKnownCursor: 0,
		},
		"hello_ack",
	);
	assert(
		helloA.cursor === 0,
		`expected initial cursor 0 for local-vault-a, got ${helloA.cursor}`,
	);
	assert(
		helloB.cursor === 0,
		`expected initial cursor 0 for local-vault-b, got ${helloB.cursor}`,
	);

	const accepted = await sendSocketRequest(
		socketA,
		{
			type: "commit_mutations",
			requestId: `commit-upsert-${uniqueSuffix}`,
			mutations: [
				{
					mutationId: `mutation-smoke-upsert-${uniqueSuffix}`,
					entryId: "entry-smoke",
					op: "upsert",
					baseRevision: 0,
					blobId,
					encryptedMetadata: "meta-smoke-1",
				},
			],
		},
		"commit_mutations_committed",
	);
	const notified = await waitForCursorAdvanced(socketB, 1);
	assert(accepted.cursor === 1, `expected commit cursor 1, got ${accepted.cursor}`);
	assert(accepted.results[0]?.status === "accepted", "expected upsert commit accepted");
	assert(notified.cursor === 1, `expected notification cursor 1, got ${notified.cursor}`);

	const changes = await sendSocketRequest(
		socketB,
		{
			type: "list_entry_states",
			requestId: `list-upsert-${uniqueSuffix}`,
			sinceCursor: 0,
			targetCursor: null,
			after: null,
			limit: 100,
		},
		"entry_states_listed",
	);
	assert(changes.targetCursor === 1, `expected pull cursor 1, got ${changes.targetCursor}`);
	assert(Array.isArray(changes.entries) && changes.entries.length === 1, "expected one pulled entry");
	assert(changes.entries[0]?.entryId === "entry-smoke", "pulled entry id mismatch");

	socketB.close();

	const deleted = await sendSocketRequest(
		socketA,
		{
			type: "commit_mutations",
			requestId: `commit-delete-${uniqueSuffix}`,
			mutations: [
				{
					mutationId: `mutation-smoke-delete-${uniqueSuffix}`,
					entryId: "entry-smoke",
					op: "delete",
					baseRevision: 1,
					blobId: null,
					encryptedMetadata: "meta-smoke-delete",
				},
			],
		},
		"commit_mutations_committed",
	);
	assert(deleted.cursor === 2, `expected delete cursor 2, got ${deleted.cursor}`);
	assert(deleted.results[0]?.status === "accepted", "expected delete commit accepted");

	const socketBReconnect = await openSocket(socketUrl(baseUrl, vaultId), tokenB.token);
	const helloBReconnect = await sendSocketRequest(
		socketBReconnect,
		{
			type: "hello",
			requestId: `hello-b-reconnect-${uniqueSuffix}`,
			lastKnownCursor: 1,
		},
		"hello_ack",
	);
	assert(helloBReconnect.cursor === 2, `expected reconnect hello cursor 2, got ${helloBReconnect.cursor}`);

	const deleteChanges = await sendSocketRequest(
		socketBReconnect,
		{
			type: "list_entry_states",
			requestId: `list-delete-${uniqueSuffix}`,
			sinceCursor: 1,
			targetCursor: null,
			after: null,
			limit: 100,
		},
		"entry_states_listed",
	);
	assert(deleteChanges.targetCursor === 2, `expected delete pull cursor 2, got ${deleteChanges.targetCursor}`);
	assert(Array.isArray(deleteChanges.entries) && deleteChanges.entries.length === 1, "expected one delete entry");
	assert(deleteChanges.entries[0]?.deleted === true, "expected pulled delete state");

	socketA.close();
	socketBReconnect.close();

	console.log("websocket smoke passed");
}

async function signUpAndCreateVault(baseUrl, { email, name, password, vaultName }) {
	const signUp = await jsonRequest(`${baseUrl}/api/auth/sign-up/email`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
		},
		body: JSON.stringify({ name, email, password }),
	});
	expectStatus(signUp, 200, 299, `sign-up:${email}`);

	const sessionCookie = extractCookieHeader(signUp.response);
	assert(sessionCookie.length > 0, `sign-up did not return session cookie for ${email}`);

	const createdVault = await jsonRequest(`${baseUrl}/v1/vaults`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			cookie: sessionCookie,
		},
		body: JSON.stringify({
			name: vaultName,
			initialWrapper: {
				kind: "password",
				envelope: {
					version: 1,
					keyVersion: 1,
					kdf: {
						name: "argon2id",
						memoryKiB: 65536,
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
			},
		}),
	});
	expectStatus(createdVault, 200, 299, `create-vault:${vaultName}`);
	assert(createdVault.json?.vault?.id, `created vault id is missing for ${vaultName}`);

	return {
		sessionCookie,
		vaultId: createdVault.json.vault.id,
	};
}

async function issueSyncToken(baseUrl, sessionCookie, vaultId, localVaultId) {
	const response = await jsonRequest(`${baseUrl}/v1/sync/token`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			cookie: sessionCookie,
		},
		body: JSON.stringify({ vaultId, localVaultId }),
	});
	expectStatus(response, 200, 299, `issue-token:${localVaultId}`);
	assert(response.json?.token, `missing token for ${localVaultId}`);
	return response.json;
}

function socketUrl(baseUrl, vaultId) {
	const url = new URL(`${baseUrl}/v1/vaults/${encodeURIComponent(vaultId)}/socket`);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.toString();
}

async function openSocket(url, token) {
	return await new Promise((resolve, reject) => {
		const socket = new WebSocket(url, {
			headers: {
				authorization: `Bearer ${token}`,
			},
		});
		const queue = [];
		const waiters = [];
		let terminalError = null;
		let settled = false;

		const fail = (error) => {
			const normalized = error instanceof Error ? error : new Error(String(error));
			terminalError = normalized;

			while (waiters.length > 0) {
				waiters.shift().reject(normalized);
			}

			if (!settled) {
				settled = true;
				reject(normalized);
			}
		};

		socket.on("open", () => {
			if (settled) {
				return;
			}

			settled = true;
			resolve({
				send(payload) {
					socket.send(JSON.stringify(payload));
				},
				close() {
					socket.close();
				},
				async nextMessage(expectedType) {
					if (queue.length > 0) {
						return queue.shift();
					}

					if (terminalError) {
						throw terminalError;
					}

					return await new Promise((innerResolve, innerReject) => {
						const timeout = setTimeout(() => {
							const index = waiters.findIndex((entry) => entry.reject === innerReject);
							if (index >= 0) {
								waiters.splice(index, 1);
							}
							innerReject(new Error(`timed out waiting for ${expectedType}`));
						}, REQUEST_TIMEOUT_MS);

						waiters.push({
							resolve(value) {
								clearTimeout(timeout);
								innerResolve(value);
							},
							reject(error) {
								clearTimeout(timeout);
								innerReject(error);
							},
						});
					});
				},
			});
		});

		socket.on("message", (raw) => {
			let parsed;
			try {
				parsed = JSON.parse(String(raw));
			} catch (error) {
				fail(error);
				return;
			}

			if (waiters.length > 0) {
				waiters.shift().resolve(parsed);
			} else {
				queue.push(parsed);
			}
		});

		socket.on("error", (error) => {
			fail(error);
		});

		socket.on("close", (code, reason) => {
			if (code === 1000) {
				fail(new Error("websocket closed"));
				return;
			}

			fail(new Error(`websocket closed: ${code} ${String(reason)}`));
		});
	});
}

async function waitForSocketMessage(socket, expectedType) {
	while (true) {
		const payload = await socket.nextMessage(expectedType);
		if (payload.type === expectedType) {
			return payload;
		}
	}
}

async function sendSocketRequest(socket, payload, expectedType) {
	socket.send(payload);
	while (true) {
		const response = await socket.nextMessage(expectedType);
		if (response.type === "session_error") {
			throw new Error(`websocket session error: ${response.code} ${response.message}`);
		}
		if (
			response.type === "commit_mutations_failed" &&
			response.requestId === payload.requestId
		) {
			throw new Error(`websocket commit rejected: ${response.code} ${response.message}`);
		}
		if (
			response.type === "entry_states_list_failed" &&
			response.requestId === payload.requestId
		) {
			throw new Error(`websocket list entry states failed: ${response.code} ${response.message}`);
		}
		if (
			response.type === expectedType &&
			response.requestId === payload.requestId
		) {
			return response;
		}
	}
}

async function waitForCursorAdvanced(socket, minimumCursor) {
	while (true) {
		const payload = await waitForSocketMessage(socket, "cursor_advanced");
		if (Number(payload.cursor) >= minimumCursor) {
			return payload;
		}
	}
}

async function jsonRequest(url, init = {}) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	try {
		const target = new URL(url);
		const headers = new Headers(init.headers ?? {});
		if (!headers.has("origin")) {
			headers.set("origin", target.origin);
		}
		if (!headers.has("referer")) {
			headers.set("referer", `${target.origin}/`);
		}

		const response = await fetch(url, {
			...init,
			headers,
			signal: controller.signal,
		});
		const text = await response.text();
		const json = tryParseJson(text);
		return { response, json, text };
	} finally {
		clearTimeout(timeout);
	}
}

function extractCookieHeader(response) {
	const cookies = response.headers.getSetCookie?.() ?? [];
	if (cookies.length > 0) {
		return cookies
			.map((cookie) => cookie.split(";")[0]?.trim())
			.filter(Boolean)
			join("; ");
	}

	const cookie = response.headers.get("set-cookie");
	return cookie?.split(";")[0]?.trim() ?? "";
}

function expectStatus(result, min, max, label) {
	const { response, json, text } = result;
	assert(
		response.status >= min && response.status <= max,
		`${label} failed: status=${response.status} body=${json ? JSON.stringify(json) : text}`,
	);
}

function normalizeBaseUrl(value) {
	return value.replace(/\/+$/, "");
}

function tryParseJson(text) {
	if (!text) {
		return null;
	}

	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function assert(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack ?? error.message : error);
	process.exit(1);
});
