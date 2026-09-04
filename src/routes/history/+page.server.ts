import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { dbFrom } from '$lib/server/api/identity';
import { listMatchesForUser, MATCH_PAGE_LIMIT_MAX } from '$lib/server/api/matches';

/**
 * 対戦履歴（doc/designs/17-frontend.md 1節）。
 *
 * 一覧は必ずセッションのユーザ ID を WHERE 句に含めて引く
 * （doc/designs/10-auth-and-access.md 10.3）。
 */
export const load = (async (event) => {
	const { user } = event.locals;
	if (!user) return redirect(303, '/home');

	const requested = Number(event.url.searchParams.get('limit') ?? 20);
	const page = await listMatchesForUser(dbFrom(event), user.id, {
		limit: Number.isFinite(requested) ? Math.min(Math.max(requested, 1), MATCH_PAGE_LIMIT_MAX) : 20,
		cursor: event.url.searchParams.get('cursor')
	});

	return { ...page };
}) satisfies PageServerLoad;
