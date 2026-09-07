import { fail, redirect } from '@sveltejs/kit';
import { APIError } from 'better-auth/api';
import type { Actions } from './$types';
import { m } from '$lib/paraglide/messages';
import { audit } from '$lib/server/security';

/**
 * ログインの2段階目（doc/designs/10-auth-and-access.md 10.4）。
 *
 * MFA を有効にしたアカウント（＝管理者）は `signInEmail` でセッションを受け取らず、
 * ここで TOTP を確認して初めてセッションが発行される。失敗は `security_event` に残す
 * （「管理者ログインは成功・失敗とも全件通知」の材料。doc/designs/14-observability.md 2.1）。
 */
export const actions = {
	default: async (event) => {
		const form = await event.request.formData();
		const code = form.get('code')?.toString().trim() ?? '';
		if (!code) return fail(400, { message: m.error_two_factor_invalid() });

		try {
			await event.locals.auth.api.verifyTOTP({
				body: { code },
				headers: event.request.headers
			});
		} catch (error) {
			if (error instanceof APIError) {
				await audit(event, {
					type: 'admin_login',
					severity: 'warn',
					detail: { stage: 'totp', result: 'failed' }
				});
				return fail(400, { message: m.error_two_factor_invalid() });
			}
			throw error;
		}

		await audit(event, {
			type: 'admin_login',
			severity: 'warn',
			detail: { stage: 'totp', result: 'ok' }
		});
		return redirect(303, '/home');
	}
} satisfies Actions;
