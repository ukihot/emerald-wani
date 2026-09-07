import { fail } from '@sveltejs/kit';
import type { ActionFailure, RequestEvent } from '@sveltejs/kit';
import { hashSignal } from '$lib/protocol/audit';
import { m } from '$lib/paraglide/messages';
import { audit, auditSecret, clientIp, ipHashOf } from '$lib/server/security';
import { limiter, withinLimit } from '$lib/server/rate-limit';
import { TURNSTILE_FIELD, verifyTurnstile } from '$lib/server/turnstile';

/**
 * 認証系フォーム（ログイン・本登録・再設定要求・再設定）の共通ゲート
 * （doc/designs/11-security-controls.md 11.4）。
 *
 *   1. Turnstile を検証する（鍵未設定のローカル開発だけ素通り）
 *   2. `RL_AUTH` で IP + メールのハッシュをキーに 10件/60秒のバースト制限
 *
 * 通れば `null`、通らなければそのまま返せる `fail()` を返す。失敗は
 * `security_event` に残す（監視の「ログイン失敗率」「単一アカウントへの失敗」の材料）。
 * 応答文言はアカウントの存否を区別しない。
 */
export async function authGate(
	event: RequestEvent,
	form: FormData,
	emailForKey: string,
	at: string
): Promise<ActionFailure<{ message: string }> | null> {
	const captcha = await verifyTurnstile(
		form.get(TURNSTILE_FIELD)?.toString(),
		clientIp(event.request.headers)
	);
	if (!captcha.ok) {
		await audit(event, {
			type: 'captcha_failed',
			severity: 'warn',
			detail: { at, reason: captcha.reason }
		});
		return fail(400, { message: m.error_captcha_failed() });
	}

	const ipHash = await ipHashOf(event);
	// メールは生のままキーにしない（レート制限のキーはログや指標に載りうるため）。
	const emailHash = emailForKey ? await hashSignal(auditSecret(), emailForKey) : null;
	if (!(await withinLimit(limiter(event, 'RL_AUTH'), `${ipHash}:${emailHash ?? '-'}`))) {
		await audit(event, { type: 'rate_limited', severity: 'warn', detail: { at, layer: 'auth' } });
		return fail(429, { message: m.error_auth_rate_limited() });
	}

	return null;
}
