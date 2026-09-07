import { fail, redirect } from '@sveltejs/kit';
import { APIError } from 'better-auth/api';
import type { Actions, PageServerLoad } from './$types';
import { isGuest } from '$lib/server/api/identity';
import { m } from '$lib/paraglide/messages';
import { authGate } from '$lib/server/auth-gate';
import { audit } from '$lib/server/security';

/** ログイン（doc/designs/17-frontend.md 1節）。 */

export const load = (async ({ locals }) => {
	if (locals.user && !isGuest(locals.user)) return redirect(303, '/home');
	return {};
}) satisfies PageServerLoad;

export const actions = {
	default: async (event) => {
		const form = await event.request.formData();
		const email = form.get('email')?.toString().trim() ?? '';
		const password = form.get('password')?.toString() ?? '';

		const gate = await authGate(event, form, email, 'login');
		if (gate) return gate;

		try {
			// ログイン成功時、better-auth は新しいセッションを発行する
			// （セッション固定攻撃対策。doc/designs/10-auth-and-access.md 10.2）。
			const result = await event.locals.auth.api.signInEmail({
				body: { email, password },
				headers: event.request.headers
			});
			// MFA を有効にしたアカウント（＝管理者）はここでセッションを受け取らない。
			// 二段階目の TOTP を /two-factor で確認する（doc/designs/10-auth-and-access.md 10.4）。
			if ('twoFactorRedirect' in result && result.twoFactorRedirect) {
				return redirect(303, '/two-factor');
			}
		} catch (error) {
			if (error instanceof APIError) {
				// 「メールアドレスが存在しない」と「パスワードが違う」を区別しない
				// （アカウント列挙の防止）。better-auth も同じ文言を返す。
				await audit(event, {
					type: 'login_failed',
					severity: 'warn',
					detail: { reason: error.body?.code ?? 'unknown' }
				});
				return fail(400, { email, message: m.error_invalid_credentials() });
			}
			console.error('sign-in failed', error);
			return fail(500, { email, message: m.error_login_unexpected() });
		}

		return redirect(303, '/home');
	}
} satisfies Actions;
