import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/auth-guard';
import { errorResponse } from '$lib/server/api/responses';
import { CURRENT_TICKET_KID, TICKET_TTL_SECONDS, signTicket } from '$lib/protocol/ws-ticket';

/**
 * POST /api/v1/matches/{id}/ws-ticket
 *
 * WebSocket 接続用の短命チケットを発行する。認可: 参加者のみ
 * （doc/designs/09-api-protocol.md、doc/designs/11-security-controls.md 11.2）。
 *
 * 参加者かどうかは MatchRoom DO 自身に問い合わせる（D1 に対戦の一覧を持たないため。
 * doc/designs/07-durable-objects.md）。参加者でなければ 403 ではなく 404 を返し、
 * 対戦の存在有無を漏らさない（doc/designs/10-auth-and-access.md 10.3）。
 */

const MATCH_ID_PATTERN = /^[0-9a-f-]{36}$/i;

export const POST: RequestHandler = async ({ params, locals, platform }) => {
	const { user } = requireUser(locals);
	if (!platform?.env?.MATCH_ROOM || !platform.env.WS_TICKET_SECRET_V1) {
		return errorResponse(500, 'E_INTERNAL', '対戦機能が利用できません');
	}

	const matchId = params.id;
	if (!matchId || !MATCH_ID_PATTERN.test(matchId)) {
		return errorResponse(404, 'E_NOT_FOUND', '対戦が見つかりません');
	}

	const stub = platform.env.MATCH_ROOM.get(platform.env.MATCH_ROOM.idFromName(matchId));
	const lookup = await stub.fetch(
		`http://match-room.internal/internal/seat?userId=${encodeURIComponent(user.id)}`
	);
	const lookupBody = (await lookup.json()) as {
		seat: 0 | 1 | null;
		ruleVersion: string | null;
	};

	if (lookupBody.seat === null || !lookupBody.ruleVersion) {
		// 参加していない、または対戦がまだ存在しない。どちらも同じ 404 で返す。
		return errorResponse(404, 'E_NOT_FOUND', '対戦が見つかりません');
	}

	const now = Math.floor(Date.now() / 1000);
	const ticket = await signTicket(
		{
			kid: CURRENT_TICKET_KID,
			mid: matchId,
			uid: user.id,
			seat: lookupBody.seat,
			jti: crypto.randomUUID(),
			exp: now + TICKET_TTL_SECONDS,
			rv: lookupBody.ruleVersion
		},
		platform.env.WS_TICKET_SECRET_V1
	);

	return new Response(JSON.stringify({ ticket }), {
		status: 200,
		headers: { 'content-type': 'application/json' }
	});
};
