import { fail, redirect } from '@sveltejs/kit';
import { APIError } from 'better-auth/api';
import type { Actions, PageServerLoad } from './$types';
import { dbFrom, isGuest } from '$lib/server/api/identity';
import { ensurePlayerProfile } from '$lib/server/account-migration';
import { listMatchesForUser, summarizeRecord } from '$lib/server/api/matches';
import { m } from '$lib/paraglide/messages';

/**
 * ホーム（doc/designs/17-frontend.md 1節）。対戦導線と戦績要約を出す。
 *
 * 未認証なら「すぐ遊ぶ」ボタンだけを見せる。ゲストの発行は**ボタン起点の明示発行**で
 * あり、画面を開いただけではアカウントを作らない（doc/designs/10-auth-and-access.md 10.1）。
 */

export const load = (async (event) => {
	const { user } = event.locals;
	if (!user) return { authenticated: false as const };

	const db = dbFrom(event);
	const profile = await ensurePlayerProfile(db, user.id, user.name);
	const [record, recent] = await Promise.all([
		summarizeRecord(db, user.id),
		listMatchesForUser(db, user.id, { limit: 5 })
	]);

	return {
		authenticated: true as const,
		displayName: profile?.displayName ?? user.name,
		guest: isGuest(user),
		emailVerified: user.emailVerified,
		record,
		recent: recent.matches
	};
}) satisfies PageServerLoad;

export const actions = {
	/**
	 * 「すぐ遊ぶ」。ここで初めてゲストユーザーが作られる。
	 *
	 * TODO(フェーズ6): 発行前に Turnstile を検証する（doc/designs/10-auth-and-access.md
	 * 10.1、doc/designs/21-roadmap.md のフェーズ6）。同一 IP からの発行回数制限は
	 * `GuestIssuanceGuard` DO が担う。
	 */
	playAsGuest: async (event) => {
		if (event.locals.user) return redirect(303, '/play');
		try {
			await event.locals.auth.api.signInAnonymous({ headers: event.request.headers });
		} catch (error) {
			if (error instanceof APIError) {
				return fail(400, { message: m.error_guest_start_failed() });
			}
			throw error;
		}
		return redirect(303, '/play');
	},

	signOut: async (event) => {
		await event.locals.auth.api.signOut({ headers: event.request.headers });
		return redirect(303, '/home');
	}
} satisfies Actions;
