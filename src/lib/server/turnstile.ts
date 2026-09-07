import { env } from '$env/dynamic/private';

/**
 * Turnstile のサーバ側検証（doc/designs/11-security-controls.md 11.4 / 11.8.1）。
 *
 * 登録・ログイン・パスワード再設定・ゲスト発行に適用する。トークンは5分で失効し
 * **単回使用**なので、フォーム送信のたびに検証し、失敗したらウィジェットを再取得させる。
 *
 * better-auth の `captcha` プラグインは使わない。認証画面は form actions から
 * `auth.api.*` を直接呼んでおり `/api/auth/**` を通らないため同プラグインの
 * `onRequest` が発火せず、さらにゲスト発行はそもそも対象外だからである
 * （src/lib/server/auth.ts の注記）。
 *
 * ローカル開発では `TURNSTILE_SECRET_KEY` 未設定を許し、検証を飛ばす。
 * **`ENVIRONMENT` が development 以外のときは飛ばさない**（鍵の入れ忘れで Bot 対策が
 * 黙って無効化されるのを防ぐ。フェイルクローズ）。
 */

const SITE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** フォームに埋める hidden input の名前（Turnstile ウィジェットが自動で作る）。 */
export const TURNSTILE_FIELD = 'cf-turnstile-response';

export type TurnstileResult = { ok: true; skipped: boolean } | { ok: false; reason: string };

export async function verifyTurnstile(
	token: string | undefined,
	remoteIp?: string,
	config: { secret?: string; environment?: string } = {
		secret: env.TURNSTILE_SECRET_KEY,
		environment: env.ENVIRONMENT
	}
): Promise<TurnstileResult> {
	const secret = config.secret?.trim();
	if (!secret) {
		if ((config.environment ?? 'development') === 'development') return { ok: true, skipped: true };
		return { ok: false, reason: 'missing-secret' };
	}
	if (!token) return { ok: false, reason: 'missing-token' };

	const body = new FormData();
	body.set('secret', secret);
	body.set('response', token);
	if (remoteIp && remoteIp !== 'local') body.set('remoteip', remoteIp);

	try {
		const response = await fetch(SITE_VERIFY_URL, { method: 'POST', body });
		const outcome = (await response.json()) as { success?: boolean; 'error-codes'?: string[] };
		if (outcome.success) return { ok: true, skipped: false };
		return { ok: false, reason: outcome['error-codes']?.join(',') || 'verification-failed' };
	} catch (error) {
		// 検証先へ到達できない場合は通さない（フェイルクローズ）。
		console.error('turnstile siteverify failed', error);
		return { ok: false, reason: 'siteverify-unreachable' };
	}
}
