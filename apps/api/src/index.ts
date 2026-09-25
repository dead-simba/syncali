import { logServerError } from "./errors";
import { createQueueConsumer, getRuntimeApp } from "./runtime";
import type { QueueMessage } from "./runtime";
export { SyncCoordinator } from "./sync-coordinator";

export default {
	async fetch(request, env): Promise<Response> {
		try {
			return await getRuntimeApp(env, request).fetch(request);
		} catch (error) {
			logServerError("fetch", error, request);
			return Response.json(
				{
					error: "internal_error",
					message: "unexpected server error",
				},
				{ status: 500 },
			);
		}
	},
	async queue(batch, env): Promise<void> {
		await createQueueConsumer(env).handleBatch(batch);
	},
} satisfies ExportedHandler<Env, QueueMessage>;
