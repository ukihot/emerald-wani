import { fail } from '@sveltejs/kit';
import { APIError } from 'better-auth/api';
import type { Actions } from './$types';
import { m } from '$lib/paraglide/messages';

/**
 * パスワード再設定の要求（doc/designs/10-auth-and-access.md 10.1）。
 *
 * 再設定トークンは有効期限15分・単回使用（better-auth が `verification` を消費する）。
 * メールが登録されているかどうかを応答で区別しない（アカウント列挙の防止）。
 */
export const actions = {
	default: async (event) => {
		const form = await event.request.formData();
		const email = form.get('email')?.toString().trim() ?? '';
		if (!email) return fail(400, { message: m.error_email_required() });

		try {
			await event.locals.auth.api.requestPasswordReset({
				body: { email, redirectTo: '/reset-password' },
				headers: event.request.headers
			});
		} catch (error) {
			// 実在しないメールアドレスでも成功として扱う。配送側の失敗だけログへ残す。
			if (!(error instanceof APIError)) console.error('password reset request failed', error);
		}

		return { sent: true };
	}
} satisfies Actions;
