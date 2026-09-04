import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/auth-guard';
import { errorResponse } from '$lib/server/api/responses';
import { getDb } from '$lib/server/db';
import {
	MATCH_PAGE_LIMIT_DEFAULT,
	MATCH_PAGE_LIMIT_MAX,
	listMatchesForUser
} from '$lib/server/api/matches';

/**
 * GET /api/v1/matches — 自分の対戦履歴（doc/designs/09-api-protocol.md 1節）。
 *
 * カーソルページングで、`limit` の上限は50。ゲストも自分の履歴を読めるが、
 * ゲストのセッションは7日で失効し復元できない（doc/designs/10-auth-and-access.md 10.1）。
 */
export const GET: RequestHandler = async ({ locals, platform, url }) => {
	const { user } = requireUser(locals);
	if (!platform?.env?.DB) return errorResponse(500, 'E_INTERNAL', 'データベースに接続できません');

	const requestedLimit = Number(url.searchParams.get('limit') ?? MATCH_PAGE_LIMIT_DEFAULT);
	if (!Number.isFinite(requestedLimit) || requestedLimit < 1) {
		return errorResponse(400, 'E_MALFORMED', 'limit が不正です');
	}

	const page = await listMatchesForUser(getDb(platform.env.DB), user.id, {
		limit: Math.min(requestedLimit, MATCH_PAGE_LIMIT_MAX),
		cursor: url.searchParams.get('cursor')
	});
	return json(page);
};
