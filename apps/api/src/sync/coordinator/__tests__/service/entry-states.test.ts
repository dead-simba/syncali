import { describe, expect, it, vi } from "vitest";

import type { EntryStateRow } from "../../types";
import {
	createCoordinatorService,
	createMockCoordinatorSocketService,
	createTestCoordinatorState,
	testSocketSession,
	testWebSocket,
	type TestCoordinatorState,
} from "./helpers";

describe("coordinator entry-state sync", () => {
	it("lists entry-state delta pages over the websocket control channel", async () => {
		const session = testSocketSession();
		const sender = testWebSocket();
		const socketService = createMockCoordinatorSocketService({
			readSocketSession: vi.fn(() => session),
			sendSocketMessage: vi.fn(),
		});
		const stateRepository = createTestCoordinatorState({
			currentCursor: vi.fn(() => 10),
			countEntryStates: vi.fn(() => 1),
			listEntryStates: vi.fn(() => [
				{
					entry_id: "entry-1",
					revision: 2,
					blob_id: "blob-1",
					encrypted_metadata: "metadata",
					deleted: false,
					updated_seq: 4,
					updated_at: 123,
				},
			]),
		});
		const service = createCoordinatorService({ stateRepository, socketService });

		await service.handleSocketMessage(
			sender,
			JSON.stringify({
				type: "list_entry_states",
				requestId: "request-entry-states",
				sinceCursor: 2,
				targetCursor: null,
				after: null,
				limit: 100,
			}),
		);

		expect(stateRepository.listEntryStates).toHaveBeenCalledWith(2, 10, null, 101);
		expect(stateRepository.countEntryStates).toHaveBeenCalledWith(2, 10);
		expect(socketService.sendSocketMessage).toHaveBeenCalledWith(sender, {
			type: "entry_states_listed",
			requestId: "request-entry-states",
			targetCursor: 10,
			totalEntries: 1,
			hasMore: false,
			nextAfter: null,
			entries: [
				{
					entryId: "entry-1",
					revision: 2,
					blobId: "blob-1",
					encryptedMetadata: "metadata",
					deleted: false,
					updatedSeq: 4,
					updatedAt: 123,
				},
			],
		});
	});

	it.each([
		{
			name: "since cursor ahead of the server",
			sinceCursor: 11,
			targetCursor: null,
			code: "cursor_ahead_of_server",
		},
		{
			name: "target cursor ahead of the server",
			sinceCursor: 2,
			targetCursor: 11,
			code: "invalid_cursor_range",
		},
		{
			name: "target cursor behind the since cursor",
			sinceCursor: 8,
			targetCursor: 7,
			code: "invalid_cursor_range",
		},
	])("rejects an invalid entry-state range: $name", async (input) => {
		const session = testSocketSession();
		const sender = testWebSocket();
		const socketService = createMockCoordinatorSocketService({
			readSocketSession: vi.fn(() => session),
			sendSocketMessage: vi.fn(),
		});
		const listEntryStates = vi.fn();
		const stateRepository = createTestCoordinatorState({
			currentCursor: vi.fn(() => 10),
			listEntryStates,
		});
		const service = createCoordinatorService({ stateRepository, socketService });

		await service.handleSocketMessage(
			sender,
			JSON.stringify({
				type: "list_entry_states",
				requestId: "request-entry-states",
				sinceCursor: input.sinceCursor,
				targetCursor: input.targetCursor,
				after: null,
				limit: 100,
			}),
		);

		expect(socketService.sendSocketMessage).toHaveBeenCalledWith(
			sender,
			expect.objectContaining({
				type: "entry_states_list_failed",
				requestId: "request-entry-states",
				code: input.code,
			}),
		);
		expect(listEntryStates).not.toHaveBeenCalled();
	});
});

describe("coordinator entry-state lookup by id", () => {
	function entryRow(entryId: string, overrides: Partial<EntryStateRow> = {}): EntryStateRow {
		return {
			entry_id: entryId,
			revision: 3,
			blob_id: `blob-${entryId}`,
			encrypted_metadata: `metadata-${entryId}`,
			deleted: false,
			updated_seq: 9,
			updated_at: 456,
			...overrides,
		};
	}

	function setup(readEntryStates: TestCoordinatorState["readEntryStates"]) {
		const sender = testWebSocket();
		const socketService = createMockCoordinatorSocketService({
			readSocketSession: vi.fn(() => testSocketSession()),
			sendSocketMessage: vi.fn(),
		});
		const stateRepository = createTestCoordinatorState({ readEntryStates });
		const service = createCoordinatorService({ stateRepository, socketService });
		return { sender, socketService, stateRepository, service };
	}

	it("advertises the lookup in the hello acknowledgement", async () => {
		const { sender, socketService, service } = setup(vi.fn(() => []));

		await service.handleSocketMessage(
			sender,
			JSON.stringify({ type: "hello", requestId: "request-hello", lastKnownCursor: 0 }),
		);

		expect(socketService.sendSocketMessage).toHaveBeenCalledWith(
			sender,
			expect.objectContaining({
				type: "hello_ack",
				features: expect.arrayContaining(["get_entry_states"]),
			}),
		);
	});

	it("returns the requested entries in request order and leaves out unknown ids", async () => {
		const readEntryStates = vi.fn(() => [
			entryRow("entry-2", { deleted: true, blob_id: null, revision: 5 }),
			entryRow("entry-1"),
		]);
		const { sender, socketService, service } = setup(readEntryStates);

		await service.handleSocketMessage(
			sender,
			JSON.stringify({
				type: "get_entry_states",
				requestId: "request-by-id",
				entryIds: ["entry-1", "entry-missing", "entry-2"],
			}),
		);

		expect(readEntryStates).toHaveBeenCalledWith(["entry-1", "entry-missing", "entry-2"]);
		expect(socketService.sendSocketMessage).toHaveBeenCalledWith(sender, {
			type: "entry_states_by_id",
			requestId: "request-by-id",
			entries: [
				{
					entryId: "entry-1",
					revision: 3,
					blobId: "blob-entry-1",
					encryptedMetadata: "metadata-entry-1",
					deleted: false,
					updatedSeq: 9,
					updatedAt: 456,
				},
				{
					entryId: "entry-2",
					revision: 5,
					blobId: null,
					encryptedMetadata: "metadata-entry-2",
					deleted: true,
					updatedSeq: 9,
					updatedAt: 456,
				},
			],
		});
	});

	it("answers an over-limit lookup with a failure the client can match to its request", async () => {
		const readEntryStates = vi.fn(() => []);
		const { sender, socketService, service } = setup(readEntryStates);

		await service.handleSocketMessage(
			sender,
			JSON.stringify({
				type: "get_entry_states",
				requestId: "request-too-many",
				entryIds: Array.from({ length: 101 }, (_, i) => `entry-${i}`),
			}),
		);

		expect(socketService.sendSocketMessage).toHaveBeenCalledTimes(1);
		expect(socketService.sendSocketMessage).toHaveBeenCalledWith(sender, {
			type: "entry_states_by_id_failed",
			requestId: "request-too-many",
			code: "invalid_message",
			message: "entryIds: Too big: expected array to have <=100 items",
		});
		expect(readEntryStates).not.toHaveBeenCalled();
	});

	it("reports a storage failure against the request that caused it", async () => {
		const { sender, socketService, service } = setup(
			vi.fn(() => {
				throw new Error("sqlite is unavailable");
			}),
		);

		await service.handleSocketMessage(
			sender,
			JSON.stringify({
				type: "get_entry_states",
				requestId: "request-by-id",
				entryIds: ["entry-1"],
			}),
		);

		expect(socketService.sendSocketMessage).toHaveBeenCalledWith(sender, {
			type: "entry_states_by_id_failed",
			requestId: "request-by-id",
			code: "entry_states_by_id_failed",
			message: "sqlite is unavailable",
		});
	});
});
