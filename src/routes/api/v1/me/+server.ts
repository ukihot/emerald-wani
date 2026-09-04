import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/auth-guard';
import { errorResponse } from '$lib/server/api/responses';
import { getDb } from '$lib/server/db';
import { ensurePlayerProfile } from '$lib/server/account-migration';
import { isGuest } from '$lib/server/api/identity';
import { summarizeRecord } from '$lib/server/api/matches';

/**
 * GET /api/v1/me — 自分のプロフィールと戦績要約。
 *
 * 認可: anonymous+（doc/designs/09-api-protocol.md 1節）。ゲストも本登録ユーザーと
 * 同じ内容を返す。ゲストの戦績は本登録時に `onLinkAccount` で引き継がれる。
 * メールアドレスは返さない（画面表示に不要で、漏えい面を広げないため）。
 */
export const GET: RequestHandler = async ({ locals, platform }) => {
	const { user } = requireUser(locals);
	if (!platform?.env?.DB) return errorResponse(500, 'E_INTERNAL', 'データベースに接続できません');

	const db = getDb(platform.env.DB);
	const profile = await ensurePlayerProfile(db, user.id, user.name);
	const record = await summarizeRecord(db, user.id);

	return json({
		user: {
			id: user.id,
			displayName: profile?.displayName ?? user.name,
			isAnonymous: isGuest(user),
			emailVerified: user.emailVerified
		},
		record
	});
};
