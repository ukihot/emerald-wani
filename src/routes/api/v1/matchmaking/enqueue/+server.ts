import * as v from 'valibot';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/auth-guard';
import { errorResponse } from '$lib/server/api/responses';

/**
 * POST /api/v1/matchmaking/enqueue
 *
 * ランダムマッチの待機列に加わる。認可: anonymous+（doc/designs/09-api-protocol.md）。
 * userId はセッションから解決し、リクエストボディからは受け取らない
 * （doc/designs/10-auth-and-access.md 10.3）。
 *
 * MVP はレート帯を1つ（bucket = "all"）とする（doc/designs/07-durable-objects.md 9.4）。
 */

const BodySchema = v.strictObject({
	requestId: v.pipe(v.string(), v.minLength(1), v.maxLength(64))
});

const QUEUE_NAME = 'ranked_random:all';

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	const { user } = requireUser(locals);
	if (!platform?.env?.MATCH_QUEUE) {
		return errorResponse(500, 'E_INTERNAL', 'マッチング機能が利用できません');
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return errorResponse(400, 'E_MALFORMED', 'リクエストが不正です');
	}
	const parsed = v.safeParse(BodySchema, body);
	if (!parsed.success) return errorResponse(400, 'E_MALFORMED', 'リクエストが不正です');

	const stub = platform.env.MATCH_QUEUE.get(platform.env.MATCH_QUEUE.idFromName(QUEUE_NAME));
	const response = await stub.fetch('http://match-queue.internal/enqueue', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ userId: user.id, requestId: parsed.output.requestId })
	});
	return new Response(await response.text(), {
		status: response.status,
		headers: { 'content-type': 'application/json' }
	});
};
