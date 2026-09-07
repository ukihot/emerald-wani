import { fail, redirect } from '@sveltejs/kit';
import { APIError } from 'better-auth/api';
import type { Actions, PageServerLoad } from './$types';
import { isGuest } from '$lib/server/api/identity';
import { m } from '$lib/paraglide/messages';
import { authGate } from '$lib/server/auth-gate';

/**
 * 本登録（doc/designs/10-auth-and-access.md 10.1）。
 *
 * ゲストのセッションを持ったまま登録すると、better-auth の `anonymous` プラグインが
 * アカウント連携を検出し、`onLinkAccount`（src/lib/server/auth.ts）で戦績と設定を
 * 新しいアカウントへ移行してから匿名ユーザー行を削除する。そのため、
 * **セッションの Cookie を必ず better-auth へ渡す**（`headers` の受け渡しが移行の前提）。
 */

const MIN_PASSWORD_LENGTH = 8;

export const load = (async ({ locals }) => {
	if (locals.user && !isGuest(locals.user)) return redirect(303, '/home');
	return {
		guest: isGuest(locals.user),
		suggestedName: locals.user?.name ?? '',
		minPasswordLength: MIN_PASSWORD_LENGTH
	};
}) satisfies PageServerLoad;

export const actions = {
	default: async (event) => {
		const form = await event.request.formData();
		const email = form.get('email')?.toString().trim() ?? '';
		const password = form.get('password')?.toString() ?? '';
		const name = form.get('name')?.toString().trim() ?? '';

		if (!email || !password || !name) {
			return fail(400, { email, name, message: m.error_fill_all_fields() });
		}
		if (password.length < MIN_PASSWORD_LENGTH) {
			return fail(400, {
				email,
				name,
				message: m.error_password_too_short({ min: MIN_PASSWORD_LENGTH })
			});
		}

		const gate = await authGate(event, form, email, 'signup');
		if (gate) return gate;

		try {
			await event.locals.auth.api.signUpEmail({
				body: { email, password, name },
				headers: event.request.headers
			});
		} catch (error) {
			if (error instanceof APIError) {
				// 流出済みパスワード（haveIBeenPwned プラグイン）はここで弾かれる。
				// 理由が分かる文言を返す（利用者が直せない汎用文言にしない）。
				if (error.body?.code === 'PASSWORD_COMPROMISED') {
					return fail(400, { email, name, message: m.error_password_compromised() });
				}
				// better-auth の文言（英語）をそのまま出さず、こちらのカタログから返す。
				return fail(400, { email, name, message: m.error_signup_failed() });
			}
			// 移行（onLinkAccount）が失敗した場合もここに来る。匿名ユーザーは削除されて
			// いないため、戦績は失われない。原因を切り分けられるようログへ残す。
			console.error('sign-up failed', error);
			return fail(500, { email, name, message: m.error_signup_unexpected() });
		}

		return redirect(303, '/home');
	}
} satisfies Actions;
