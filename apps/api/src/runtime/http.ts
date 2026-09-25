import { createApp } from "../app";
import { createAuth } from "../auth";
import { createEmailVerificationConfig } from "../auth/email";
import type { AuthConfig } from "../auth/factory";
import { readPolarProductIdsByPlanId } from "../billing/product-ids";
import { BillingRepository } from "../billing/repository";
import { createPolarAuthPlugin } from "../billing/polar";
import { BillingService } from "../billing/service";
import { resolveOriginBinding, resolveUrlBinding } from "../config/env";
import { createDb } from "../db/client";
import { CloudflareSubscriptionPolicyRefreshQueue } from "../subscription/policy-refresh-queue";
import type { SubscriptionPolicyRefreshMessage } from "../subscription/policy-refresh-queue";
import { SubscriptionPolicyService } from "../subscription/policy-service";
import { SyncService } from "../sync/access/service";
import { SyncTokenService } from "../sync/access/token-service";
import { BlobRepository } from "../sync/blob/repository";
import { CoordinatorProxyRepository } from "../sync/coordinator/proxy-repository";
import { VaultPurgeConsumer } from "../vault/purge-consumer";
import { CloudflareVaultPurgeQueue, type VaultPurgeQueue } from "../vault/purge-queue";
import type { VaultPurgeMessage } from "../vault/purge-queue";
import { VaultRepository } from "../vault/repository";
import { VaultService } from "../vault/service";

type RuntimeEnv = Omit<
	Env,
	| "AUTH_ALLOWED_EMAILS"
	| "AUTH_EMAIL_FROM"
	| "DEV_MODE"
	| "EMAIL"
	| "POLICY_REFRESH_QUEUE"
	| "VAULT_PURGE_QUEUE"
> & {
	AUTH_ALLOWED_EMAILS?: string;
	EMAIL?: SendEmail;
	AUTH_EMAIL_FROM?: string;
	DEV_MODE?: boolean | string;
	WWW_BASE_URL?: string;
	POLAR_ACCESS_TOKEN?: string;
	POLAR_WEBHOOK_SECRET?: string;
	POLAR_STARTER_MONTHLY_PRODUCT_ID?: string;
	POLAR_STARTER_ANNUAL_PRODUCT_ID?: string;
	POLAR_SANDBOX?: string;
	POLICY_REFRESH_QUEUE?: Queue<SubscriptionPolicyRefreshMessage>;
	VAULT_PURGE_QUEUE?: Queue<VaultPurgeMessage>;
};

export type RuntimeApp = {
	fetch(request: Request): Promise<Response>;
};

/**
 * How many apps one isolate keeps per `env`. On a deploy that sets
 * BETTER_AUTH_URL there is only ever one. Without it the key is the request
 * origin, so a stream of requests with made-up Host headers could otherwise
 * grow the cache without bound.
 */
const MAX_CACHED_RUNTIME_APPS_PER_ENV = 4;

// workerd hands the same `env` object to every request an isolate serves (in
// local workerd, five requests in a row all saw one object), so keying on it
// gives one runtime per isolate. A WeakMap lets an env and the apps built from
// it be collected if the runtime ever replaces it.
const runtimeAppCache = new WeakMap<RuntimeEnv, Map<string, RuntimeApp>>();

/**
 * Returns the HTTP runtime for this env and request, building it at most once
 * per isolate and auth base URL.
 *
 * Rebuilding it on every request measured 3-5 ms of CPU warm and about 25 ms
 * cold, against a 10 ms per-request CPU limit on the Workers Free plan, so it
 * spent up to half of every blob upload's budget before the upload started.
 *
 * The cache is keyed on the resolved auth base URL and not on env alone.
 * Better Auth fixes `baseURL` when it is constructed, and on a self-hosted
 * deploy without BETTER_AUTH_URL that URL comes from the request origin, so
 * keying on env would lock every later request into the first one's origin.
 *
 * Sharing is safe because everything the runtime builds holds only bindings,
 * secrets and configuration, never anything from the request that built it:
 * repositories and services take bindings, Durable Object stubs are fetched
 * per call, and Better Auth copies its context for each API call. Better
 * Auth's context is a promise created during construction, but it settles
 * without any I/O (its telemetry is off unless BETTER_AUTH_TELEMETRY is set),
 * so later requests only ever await a promise that has already resolved (one
 * that rejected is dropped, as described below). The one exception is Better
 * Auth's `handler`, which writes `trustedOrigins` and `trustedProviders` onto
 * its shared context on every call. That is harmless only because both are
 * computed from `baseURL` and the configured `trustedOrigins`, which are
 * fixed per cache key, so every request writes the same values. Anything
 * request-scoped that is added to this runtime later has to be created
 * inside a handler, not here.
 *
 * Only a runtime that finished building is cached. If construction throws,
 * nothing is kept and the next request tries again. Better Auth is built
 * lazily inside the runtime and follows the same rule, including when its
 * setup fails after construction has returned (see `getAuth` below).
 */
export function getRuntimeApp(env: RuntimeEnv, request: Request): RuntimeApp {
	const authBaseUrl = resolveAuthBaseUrl(env, request);
	let apps = runtimeAppCache.get(env);
	if (!apps) {
		apps = new Map();
		runtimeAppCache.set(env, apps);
	}

	const cached = apps.get(authBaseUrl);
	if (cached) {
		return cached;
	}

	const app = buildRuntimeApp(env, authBaseUrl);
	if (apps.size >= MAX_CACHED_RUNTIME_APPS_PER_ENV) {
		// Maps iterate in insertion order, so this drops the oldest entry.
		const oldest = apps.keys().next();
		if (!oldest.done) {
			apps.delete(oldest.value);
		}
	}
	apps.set(authBaseUrl, app);
	return app;
}

/** Builds a fresh, uncached runtime. The Worker entry point uses `getRuntimeApp`. */
export function createRuntimeApp(env: RuntimeEnv, request: Request): RuntimeApp {
	return buildRuntimeApp(env, resolveAuthBaseUrl(env, request));
}

function resolveAuthBaseUrl(env: RuntimeEnv, request: Request): string {
	const requestOrigin = new URL(request.url).origin;
	return resolveUrlBinding("BETTER_AUTH_URL", env.BETTER_AUTH_URL, requestOrigin);
}

function buildRuntimeApp(env: RuntimeEnv, authBaseUrl: string): RuntimeApp {
	const publicOrigin = new URL(authBaseUrl).origin;
	const devMode = resolveBooleanBinding(env.DEV_MODE, false);
	const corsOrigin = devMode
		? "http://localhost:4321"
		: resolveOriginBinding("WWW_BASE_URL", env.WWW_BASE_URL, "http://localhost:4321");
	const db = createDb(env.DB);
	const billingRepository = new BillingRepository(db);
	const productIdsByPlanId = readPolarProductIdsByPlanId(env);
	const polarConfig = {
		accessToken: env.POLAR_ACCESS_TOKEN,
		webhookSecret: env.POLAR_WEBHOOK_SECRET,
		sandbox: resolveBooleanBinding(env.POLAR_SANDBOX, false),
		publicBaseUrl: authBaseUrl,
	};
	const vaultRepository = new VaultRepository(db);
	const coordinatorProxyRepository = new CoordinatorProxyRepository(env.SYNC_COORDINATOR);
	const subscriptionPolicyService = new SubscriptionPolicyService(env.SELF_HOSTED, db, {
		productIdsByPlanId,
	});
	// Read before Better Auth is deferred below, so a deploy missing one of
	// these still fails every request, as it did when everything was built up
	// front, instead of only the ones that sign in: the allow list on a
	// self-hosted deploy, and the managed deploy's email settings, which
	// `createAuth` checks the same way.
	const allowedEmails = env.SELF_HOSTED
		? requireNonBlankStringBinding(env.AUTH_ALLOWED_EMAILS, "AUTH_ALLOWED_EMAILS")
		: undefined;
	const authConfig: AuthConfig = {
		baseURL: authBaseUrl,
		trustedOrigins: Array.from(new Set([publicOrigin, corsOrigin])),
		selfHosted: env.SELF_HOSTED,
		devMode,
		email: env.EMAIL,
		emailFrom: env.AUTH_EMAIL_FROM,
		allowedEmails,
	};
	createEmailVerificationConfig(authConfig);
	// Better Auth and the Polar plugin are the most expensive part of this
	// runtime, and blob and coordinator requests, which are most of the
	// traffic, never touch them. Deferring them means an isolate that only
	// serves uploads never builds them at all.
	//
	// `createAuth` returns before Better Auth has finished setting up: the
	// rest runs in `$context`, which it does not await, and a bad secret or
	// config rejects there rather than throwing. Watching `$context` lets
	// such an instance be dropped like a build that threw, so the next
	// request builds a new one instead of reusing one that can never work.
	const getAuth = memoizeOnSuccess(
		() => {
			const polarAuthPlugin = env.SELF_HOSTED
				? null
				: createPolarAuthPlugin(polarConfig, billingRepository, {
						onSubscriptionUpsert: async (organizationId) => {
							const subscriptionPolicyRefreshQueue =
								new CloudflareSubscriptionPolicyRefreshQueue(
									requireBinding(env.POLICY_REFRESH_QUEUE, "POLICY_REFRESH_QUEUE"),
								);
							await subscriptionPolicyRefreshQueue.enqueueOrganizationPolicyRefresh(
								organizationId,
							);
						},
					});
			return createAuth(db, {
				...authConfig,
				plugins: polarAuthPlugin ? [polarAuthPlugin] : [],
			});
		},
		(auth) => auth.$context,
	);
	const blobRepository = new BlobRepository(env.SYNC_BLOBS);
	const syncTokenService = new SyncTokenService(env.SYNC_TOKEN_SECRET);
	const billingService = new BillingService(billingRepository, {
		...polarConfig,
		productIdsByPlanId,
		wwwBaseUrl: corsOrigin,
	});
	const vaultPurgeQueue = createVaultPurgeQueue({
		selfHosted: env.SELF_HOSTED,
		vaultRepository,
		subscriptionPolicyService,
		coordinatorProxyRepository,
		queue: env.VAULT_PURGE_QUEUE,
	});
	const vaultService = new VaultService(
		vaultRepository,
		subscriptionPolicyService,
		vaultPurgeQueue,
	);
	const syncService = new SyncService(
		vaultService,
		syncTokenService,
		env.SYNC_TOKEN_TTL_SECONDS,
	);

	const app = createApp(
		{
			getAuth,
			syncService,
			vaultService,
			syncTokenService,
			blobRepository,
			coordinatorProxyRepository,
			subscriptionPolicyService,
			billingService,
		},
		{
			publicOrigin,
			corsOrigin,
			billingEnabled: !env.SELF_HOSTED,
		},
	);

	return {
		async fetch(request: Request): Promise<Response> {
			return await app.fetch(request);
		},
	};
}

/**
 * Builds the value on first call and returns the same one afterwards. A build
 * that throws is not remembered, so the next call tries again rather than
 * failing forever on an error that may have been transient. The value is
 * built synchronously, so no promise from one request is ever handed to
 * another, which workerd would reject.
 *
 * Some values finish setting up after they are returned. `settled` names the
 * promise that tells whether that worked, and if it rejects the value is
 * forgotten the same way, so only the requests that already have it see the
 * failure. The promise is only watched here, never returned to a caller.
 */
function memoizeOnSuccess<T>(
	build: () => T,
	settled?: (value: T) => Promise<unknown>,
): () => T {
	let built: { value: T } | null = null;
	return () => {
		if (!built) {
			const current = { value: build() };
			built = current;
			settled?.(current.value).catch(() => {
				// Checked by identity so a late rejection cannot drop a newer
				// value that replaced this one.
				if (built === current) {
					built = null;
				}
			});
		}
		return built.value;
	};
}

function resolveBooleanBinding(value: boolean | string | undefined, fallback: boolean): boolean {
	if (typeof value === "boolean") {
		return value;
	}
	if (value === undefined || value.trim() === "") {
		return fallback;
	}

	return value === "true" || value === "1";
}

function createVaultPurgeQueue(input: {
	selfHosted: boolean;
	vaultRepository: VaultRepository;
	subscriptionPolicyService: SubscriptionPolicyService;
	coordinatorProxyRepository: CoordinatorProxyRepository;
	queue?: Queue<VaultPurgeMessage>;
}): VaultPurgeQueue {
	if (!input.selfHosted) {
		return new CloudflareVaultPurgeQueue(
			requireBinding(input.queue, "VAULT_PURGE_QUEUE"),
		);
	}

	const purgeVaultService = new VaultService(
		input.vaultRepository,
		input.subscriptionPolicyService,
	);
	return new InlineVaultPurgeQueue(
		new VaultPurgeConsumer(
			purgeVaultService,
			input.coordinatorProxyRepository,
		),
	);
}

class InlineVaultPurgeQueue implements VaultPurgeQueue {
	constructor(private readonly vaultPurgeConsumer: VaultPurgeConsumer) {}

	async enqueueVaultPurge(vaultId: string): Promise<void> {
		await this.vaultPurgeConsumer.purgeVault(vaultId);
	}
}

function requireBinding<T>(binding: T | undefined, name: string): T {
	if (!binding) {
		throw new Error(`${name} binding is required`);
	}

	return binding;
}

function requireNonBlankStringBinding(binding: string | undefined, name: string): string {
	if (!binding?.trim()) {
		throw new Error(`${name} binding is required`);
	}

	return binding;
}
