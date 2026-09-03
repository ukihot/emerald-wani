import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/auth-guard';
import { errorResponse } from '$lib/server/api/responses';

/** DELETE /api/v1/matchmaking — 待機キャンセル（明示キャンセル。doc/designs/07-durable-objects.md 9.4）。 */

const QUEUE_NAME = 'ranked_random:all';

export const DELETE: RequestHandler = async ({ locals, platform }) => {
	const { user } = requireUser(locals);
	if (!platform?.env?.MATCH_QUEUE) {
		return errorResponse(500, 'E_INTERNAL', 'マッチング機能が利用できません');
	}

	const stub = platform.env.MATCH_QUEUE.get(platform.env.MATCH_QUEUE.idFromName(QUEUE_NAME));
	const response = await stub.fetch(
		`http://match-queue.internal/cancel?userId=${encodeURIComponent(user.id)}`,
		{ method: 'DELETE' }
	);
	return new Response(await response.text(), {
		status: response.status,
		headers: { 'content-type': 'application/json' }
	});
};
