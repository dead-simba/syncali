import { selectSyncWebSocketProtocol } from "../../access/token";
import type {
	PolicyUpdatedMessage,
	ServerControlMessage,
	SocketSession,
	StorageStatusUpdatedMessage,
} from "../types";

export class CoordinatorSocketService {
	constructor(private readonly ctx: DurableObjectState) {}

	async openSocket(
		request: Request,
		socketSession: SocketSession,
	): Promise<Response> {
		const selectedProtocol = selectSyncWebSocketProtocol(request);
		const socketPair = new WebSocketPair();
		const client = socketPair[0];
		const server = socketPair[1];

		this.acceptWebSocket(server);
		this.attachSocketSession(server, socketSession);
		this.closeSupersededSockets(server, socketSession);

		return new Response(null, {
			status: 101,
			headers: selectedProtocol
				? {
						"Sec-WebSocket-Protocol": selectedProtocol,
					}
				: undefined,
			webSocket: client,
		});
	}

	acceptWebSocket(socket: WebSocket): void {
		this.ctx.acceptWebSocket(socket);
	}

	attachSocketSession(socket: WebSocket, session: SocketSession): void {
		socket.serializeAttachment(session);
	}

	closeSupersededSockets(current: WebSocket, session: SocketSession): void {
		for (const socket of this.ctx.getWebSockets()) {
			if (socket === current) {
				continue;
			}

			const existing = this.readSocketSession(socket);
			if (!existing) {
				continue;
			}

			if (
				existing.userId === session.userId &&
				existing.localVaultId === session.localVaultId
			) {
				this.sendSocketMessage(socket, {
					type: "session_error",
					code: "local_vault_replaced",
					message: "connection replaced by a newer sync session for this local vault",
				});
				this.closeSocket(socket, 4409, "superseded by newer connection");
			}
		}
	}

	sendSocketMessage(ws: WebSocket, message: ServerControlMessage): boolean {
		return this.trySend(ws, JSON.stringify(message));
	}

	broadcastStorageStatus(message: StorageStatusUpdatedMessage): void {
		const encoded = JSON.stringify(message);
		for (const socket of this.ctx.getWebSockets()) {
			const session = this.readSocketSession(socket);
			if (!session?.wantsStorageStatus) {
				continue;
			}
			this.trySend(socket, encoded);
		}
	}

	broadcastPolicyUpdated(message: PolicyUpdatedMessage): void {
		const encoded = JSON.stringify(message);
		for (const socket of this.ctx.getWebSockets()) {
			this.trySend(socket, encoded);
		}
	}

	broadcastExcept(excluded: WebSocket, message: ServerControlMessage): void {
		const encoded = JSON.stringify(message);
		for (const socket of this.ctx.getWebSockets()) {
			if (socket === excluded) {
				continue;
			}
			this.trySend(socket, encoded);
		}
	}

	closeAllSockets(code: number, reason: string): void {
		for (const socket of this.ctx.getWebSockets()) {
			this.closeSocket(socket, code, reason);
		}
	}

	private trySend(socket: WebSocket, encoded: string): boolean {
		if (socket.readyState !== WebSocket.OPEN) {
			return false;
		}

		try {
			socket.send(encoded);
			return true;
		} catch (error) {
			if (isClosedWebSocketSendError(error)) {
				return false;
			}
			throw error;
		}
	}

	private closeSocket(socket: WebSocket, code: number, reason: string): void {
		if (
			socket.readyState === WebSocket.CLOSING ||
			socket.readyState === WebSocket.CLOSED
		) {
			return;
		}

		try {
			socket.close(code, reason);
		} catch (error) {
			if (isClosedWebSocketCloseError(error)) {
				return;
			}
			throw error;
		}
	}

	readSocketSession(ws: WebSocket): SocketSession | null {
		const attachment = ws.deserializeAttachment();
		if (!attachment || typeof attachment !== "object") {
			return null;
		}

		const maybeSession = attachment as Partial<SocketSession>;
		if (
			typeof maybeSession.userId !== "string" ||
			typeof maybeSession.localVaultId !== "string" ||
			typeof maybeSession.vaultId !== "string"
		) {
			return null;
		}

		return {
			userId: maybeSession.userId,
			localVaultId: maybeSession.localVaultId,
			vaultId: maybeSession.vaultId,
			wantsStorageStatus: maybeSession.wantsStorageStatus === true,
		};
	}
}

function isClosedWebSocketSendError(error: unknown): boolean {
	return (
		error instanceof TypeError &&
		/after close|closed|closing/i.test(error.message)
	);
}

function isClosedWebSocketCloseError(error: unknown): boolean {
	return (
		error instanceof TypeError &&
		/already.*closed|closed|closing/i.test(error.message)
	);
}
