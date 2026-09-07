import { fail, redirect } from '@sveltejs/kit';
import { APIError } from 'better-auth/api';
import type { Actions, PageServerLoad } from './$types';
import { dbFrom, isGuest } from '$lib/server/api/identity';
import { ensurePlayerProfile } from '$lib/server/account-migration';
import { listMatchesForUser, summarizeRecord } from '$lib/server/api/matches';
import { m } from '$lib/paraglide/messages';
import { TURNSTILE_FIELD } from '$lib/server/turnstile';
import { auditGuestIssued, guestIssuanceGate } from '$lib/server/guest-issuance';

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
	 * 判定は `guestIssuanceGate` に集約している（Turnstile → バースト制限 →
	 * 1時間の厳密な窓）。同じ門を `POST /api/auth/sign-in/anonymous` にも掛けて
	 * あるため、画面を経由しない発行でも素通りしない（$lib/server/guest-issuance.ts）。
	 * 利用者が入力する項目はゼロのまま（Turnstile は Managed モード）。
	 */
	playAsGuest: async (event) => {
		if (event.locals.user) return redirect(303, '/play');

		const form = await event.request.formData();
		const gate = await guestIssuanceGate(event, form.get(TURNSTILE_FIELD)?.toString());
		if (!gate.ok) {
			return fail(gate.status, {
				message: gate.reason === 'captcha' ? m.error_captcha_failed() : m.error_guest_rate_limited()
			});
		}

		let guestUserId: string | null;
		try {
			const issued = await event.locals.auth.api.signInAnonymous({
				headers: event.request.headers
			});
			guestUserId = issued?.user?.id ?? null;
		} catch (error) {
			if (error instanceof APIError) {
				return fail(400, { message: m.error_guest_start_failed() });
			}
			throw error;
		}

		await auditGuestIssued(event, guestUserId, 'form', gate.decision);
		return redirect(303, '/play');
	},

	signOut: async (event) => {
		await event.locals.auth.api.signOut({ headers: event.request.headers });
		return redirect(303, '/home');
	}
} satisfies Actions;
