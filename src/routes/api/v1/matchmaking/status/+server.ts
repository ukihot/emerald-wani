import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/auth-guard';
import { errorResponse } from '$lib/server/api/responses';

/** GET /api/v1/matchmaking/status — 待機状況。クライアントは1秒間隔でポーリングする。 */

const QUEUE_NAME = 'ranked_random:all';

export const GET: RequestHandler = async ({ locals, platform }) => {
	const { user } = requireUser(locals);
	if (!platform?.env?.MATCH_QUEUE) {
		return errorResponse(500, 'E_INTERNAL', 'マッチング機能が利用できません');
	}

	const stub = platform.env.MATCH_QUEUE.get(platform.env.MATCH_QUEUE.idFromName(QUEUE_NAME));
	const response = await stub.fetch(
		`http://match-queue.internal/status?userId=${encodeURIComponent(user.id)}`
	);
	return new Response(await response.text(), {
		status: response.status,
		headers: { 'content-type': 'application/json' }
	});
};
