import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/auth-guard';
import { errorResponse } from '$lib/server/api/responses';
import { getDb } from '$lib/server/db';
import { findMatchDetailForUser } from '$lib/server/api/matches';

/**
 * GET /api/v1/matches/{id} — 対戦結果の詳細。認可: 参加者のみ。
 *
 * 参加していない対戦は 403 ではなく 404 を返し、存在の有無を漏らさない
 * （doc/designs/10-auth-and-access.md 10.3）。
 */

const MATCH_ID_PATTERN = /^[0-9a-f-]{36}$/i;

export const GET: RequestHandler = async ({ params, locals, platform }) => {
	const { user } = requireUser(locals);
	if (!platform?.env?.DB) return errorResponse(500, 'E_INTERNAL', 'データベースに接続できません');

	const matchId = params.id;
	if (!matchId || !MATCH_ID_PATTERN.test(matchId)) {
		return errorResponse(404, 'E_NOT_FOUND', '対戦が見つかりません');
	}

	const detail = await findMatchDetailForUser(getDb(platform.env.DB), matchId, user.id);
	if (!detail) return errorResponse(404, 'E_NOT_FOUND', '対戦が見つかりません');
	return json(detail);
};
