import { DurableObject } from "cloudflare:workers";
import type {
	CommitMutationMessage,
	CommitMutationResult,
	CommitMutationsMessage,
	CommitMutationsResult,
	DeletedEntriesListedMessage,
	EntryStatesListedMessage,
	EntryVersionsListedMessage,
	ListDeletedEntriesMessage,
	ListEntryStatesMessage,
	ListEntryVersionsMessage,
	PurgeDeletedEntriesMessage,
	RestoreEntryVersionMessage,
	RestoreEntryVersionResult,
	RestoreEntryVersionsMessage,
	RestoreEntryVersionsResult,
	SocketSession,
} from "./sync/coordinator/types";
import { CoordinatorService } from "./sync/coordinator/service";
import { createCoordinatorRuntime } from "./runtime";
import type { DeletedEntriesPurgeResult } from "./sync/coordinator/entry/history-service";

const ALARM_FAILURE_RETRY_MS = 30 * 1000;

export class SyncCoordinator extends DurableObject {
	private readonly app: ReturnType<typeof createCoordinatorRuntime>["app"];
	private readonly coordinatorService: CoordinatorService;
	private readonly ready: Promise<void>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const runtime = createCoordinatorRuntime(ctx, env);
		this.app = runtime.app;
		this.coordinatorService = runtime.coordinatorService;
		this.ready = runtime.ready;
	}

	async fetch(request: Request): Promise<Response> {
		await this.ready;
		return await this.app.fetch(request);
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		await this.ready;
		await this.coordinatorService.handleSocketMessage(ws, message);
	}

	async commitMutations(
		session: SocketSession,
		message: CommitMutationsMessage,
	): Promise<CommitMutationsResult> {
		await this.ready;
		return await this.coordinatorService.commitMutations(session, message);
	}

	async commitMutation(
		session: SocketSession,
		message: CommitMutationMessage,
	): Promise<CommitMutationResult> {
		await this.ready;
		return await this.coordinatorService.commitMutation(session, message);
	}

	async listEntryStates(
		session: SocketSession,
		message: ListEntryStatesMessage,
	): Promise<EntryStatesListedMessage> {
		await this.ready;
		return this.coordinatorService.listEntryStates(session, message);
	}

	async listEntryVersions(
		session: SocketSession,
		message: ListEntryVersionsMessage,
	): Promise<EntryVersionsListedMessage> {
		await this.ready;
		return await this.coordinatorService.listEntryVersions(session, message);
	}

	async listDeletedEntries(
		session: SocketSession,
		message: ListDeletedEntriesMessage,
	): Promise<DeletedEntriesListedMessage> {
		await this.ready;
		return await this.coordinatorService.listDeletedEntries(session, message);
	}

	async restoreEntryVersion(
		session: SocketSession,
		message: RestoreEntryVersionMessage,
	): Promise<RestoreEntryVersionResult> {
		await this.ready;
		return await this.coordinatorService.restoreEntryVersion(session, message);
	}

	async restoreEntryVersions(
		session: SocketSession,
		message: RestoreEntryVersionsMessage,
	): Promise<RestoreEntryVersionsResult> {
		await this.ready;
		return await this.coordinatorService.restoreEntryVersions(session, message);
	}

	async purgeDeletedEntries(
		session: SocketSession,
		message: PurgeDeletedEntriesMessage,
	): Promise<DeletedEntriesPurgeResult> {
		await this.ready;
		return await this.coordinatorService.purgeDeletedEntries(session, message);
	}

	async runGc(): Promise<void> {
		await this.ready;
		await this.coordinatorService.runGc();
	}

	async flushHealthSummary(): Promise<void> {
		await this.ready;
		await this.coordinatorService.flushHealthSummary({ force: true });
	}

	async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
		try {
			await this.ready;
			await this.coordinatorService.handleAlarm();
		} catch (error) {
			console.error("[sync-coordinator] durable object alarm failed", {
				objectId: this.ctx.id.toString(),
				alarmInfo,
				error: formatLogError(error),
			});
			try {
				const retryAt = Date.now() + ALARM_FAILURE_RETRY_MS;
				await this.ctx.storage.setAlarm(retryAt);
				console.error("[sync-coordinator] durable object alarm retry scheduled", {
					objectId: this.ctx.id.toString(),
					retryAt,
				});
			} catch (retryError) {
				console.error("[sync-coordinator] durable object alarm retry scheduling failed", {
					objectId: this.ctx.id.toString(),
					error: formatLogError(retryError),
				});
				throw error;
			}
		}
	}

	async webSocketClose(
		_ws: WebSocket,
		_code: number,
		_reason: string,
		_wasClean: boolean,
	): Promise<void> {
		await this.ready;
		await this.coordinatorService.handleSocketClose();
	}

	async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
		await this.ready;
		await this.coordinatorService.handleSocketClose();
	}
}

function formatLogError(error: unknown): Record<string, unknown> {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			cause: error.cause,
		};
	}
	return {
		message: String(error),
	};
}
