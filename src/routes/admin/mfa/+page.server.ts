import { fail } from '@sveltejs/kit';
import { APIError } from 'better-auth/api';
import type { Actions, PageServerLoad } from './$types';
import { recordAdminAudit, requireAdmin } from '$lib/server/admin-audit';
import { m } from '$lib/paraglide/messages';

/**
 * 管理者の MFA 登録（doc/designs/10-auth-and-access.md 10.4「管理画面は MFA 必須」）。
 *
 * `enableTwoFactor` は TOTP の URI とバックアップコードを**1回だけ**返す。表示は
 * この画面の中に閉じ、`admin_audit` にも値そのものは残さない（有効化した事実だけ）。
 */

export const load = (async (event) => {
	const identity = requireAdmin(event, { allowWithoutMfa: true });
	return {
		enabled: Boolean((event.locals.user as { twoFactorEnabled?: boolean }).twoFactorEnabled),
		role: identity.role
	};
}) satisfies PageServerLoad;

export const actions = {
	/** 現在のパスワードと引き換えに TOTP の登録情報を出す。 */
	enable: async (event) => {
		const identity = requireAdmin(event, { allowWithoutMfa: true });
		const form = await event.request.formData();
		const password = form.get('password')?.toString() ?? '';
		if (!password) return fail(400, { message: m.error_fill_all_fields() });

		try {
			const result = await event.locals.auth.api.enableTwoFactor({
				body: { password },
				headers: event.request.headers
			});
			// method: 'otp' を選んだ場合は URI もバックアップコードも返らない。
			// ここでは常に TOTP（既定）だが、型のうえで分岐を潰しておく。
			if (!('totpURI' in result)) return fail(500, { message: m.error_login_unexpected() });
			await recordAdminAudit(event, {
				adminUserId: identity.userId,
				action: 'two_factor_enabled',
				targetType: 'user',
				targetId: identity.userId
			});
			return { totpURI: result.totpURI, backupCodes: result.backupCodes };
		} catch (error) {
			if (error instanceof APIError) return fail(400, { message: m.error_invalid_credentials() });
			console.error('enable two factor failed', error);
			return fail(500, { message: m.error_login_unexpected() });
		}
	},

	/** 認証アプリのコードで登録を確認する。 */
	verify: async (event) => {
		requireAdmin(event, { allowWithoutMfa: true });
		const form = await event.request.formData();
		const code = form.get('code')?.toString() ?? '';
		try {
			await event.locals.auth.api.verifyTOTP({
				body: { code },
				headers: event.request.headers
			});
		} catch (error) {
			if (error instanceof APIError) return fail(400, { message: m.error_two_factor_invalid() });
			throw error;
		}
		return { verified: true };
	}
} satisfies Actions;
