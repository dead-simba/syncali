import type {
	EntryStatesListedMessage,
	ListEntryStatesMessage,
	SocketSession,
} from "../types";
import type { CoordinatorStateRepository } from "../state-repository";

const MAX_ENTRY_STATE_BATCH = 500;

export class EntrySyncService {
	constructor(private readonly stateRepository: CoordinatorStateRepository) {}

	listEntryStates(
		session: SocketSession,
		message: ListEntryStatesMessage,
	): EntryStatesListedMessage {
		const effectiveLimit = Math.min(message.limit, MAX_ENTRY_STATE_BATCH);
		const targetCursor =
			message.targetCursor === null
				? this.stateRepository.currentCursor()
				: message.targetCursor;
		const entries = this.stateRepository.listEntryStates(
			message.sinceCursor,
			targetCursor,
			message.after,
			effectiveLimit + 1,
		);
		const totalEntries = this.stateRepository.countEntryStates(
			message.sinceCursor,
			targetCursor,
		);
		const hasMore = entries.length > effectiveLimit;
		const page = hasMore ? entries.slice(0, effectiveLimit) : entries;
		const last = page.at(-1);

		return {
			type: "entry_states_listed",
			requestId: message.requestId,
			targetCursor,
			totalEntries,
			hasMore,
			nextAfter:
				hasMore && last
					? {
							updatedSeq: last.updated_seq,
							entryId: last.entry_id,
						}
					: null,
			entries: page.map((entry) => ({
				entryId: entry.entry_id,
				revision: entry.revision,
				blobId: entry.blob_id,
				encryptedMetadata: entry.encrypted_metadata,
				deleted: entry.deleted,
				updatedSeq: entry.updated_seq,
				updatedAt: entry.updated_at,
			})),
		};
	}
}
