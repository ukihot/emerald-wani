import { fail, redirect } from '@sveltejs/kit';
import { APIError } from 'better-auth/api';
import type { Actions, PageServerLoad } from './$types';
import { m } from '$lib/paraglide/messages';
import { authGate } from '$lib/server/auth-gate';

/**
 * 新しいパスワードの設定。メールのリンクから `?token=…` 付きで到達する。
 * トークンが無効・期限切れの場合は `?error=INVALID_TOKEN` が付く。
 */

const MIN_PASSWORD_LENGTH = 8;

export const load = (async ({ url }) => ({
	token: url.searchParams.get('token') ?? '',
	invalidToken: url.searchParams.get('error') === 'INVALID_TOKEN',
	minPasswordLength: MIN_PASSWORD_LENGTH
})) satisfies PageServerLoad;

export const actions = {
	default: async (event) => {
		const form = await event.request.formData();
		const token = form.get('token')?.toString() ?? '';
		const password = form.get('password')?.toString() ?? '';

		if (!token) return fail(400, { message: m.error_reset_link_invalid() });
		if (password.length < MIN_PASSWORD_LENGTH) {
			return fail(400, { message: m.error_password_too_short({ min: MIN_PASSWORD_LENGTH }) });
		}

		const gate = await authGate(event, form, token, 'password_reset');
		if (gate) return gate;

		try {
			// better-auth はトークンを消費し、当該ユーザーの他セッションも失効させる
			// （doc/designs/10-auth-and-access.md 10.2）。
			await event.locals.auth.api.resetPassword({
				body: { token, newPassword: password },
				headers: event.request.headers
			});
		} catch (error) {
			if (error instanceof APIError) {
				if (error.body?.code === 'PASSWORD_COMPROMISED') {
					return fail(400, { message: m.error_password_compromised() });
				}
				return fail(400, { message: m.error_reset_expired() });
			}
			console.error('password reset failed', error);
			return fail(500, { message: m.error_reset_unexpected() });
		}

		return redirect(303, '/login');
	}
} satisfies Actions;
