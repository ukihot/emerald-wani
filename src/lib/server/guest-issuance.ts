import { env } from '$env/dynamic/private';
import type { Handle, RequestEvent } from '@sveltejs/kit';
import { errorResponse } from '$lib/server/api/responses';
import { audit, clientIp, ipHashOf } from '$lib/server/security';
import { consumeGuestIssuance, type GuestIssuanceDecision } from '$lib/server/guest-guard';
import { limiter, withinLimit } from '$lib/server/rate-limit';
import { verifyTurnstile } from '$lib/server/turnstile';

/**
 * ゲスト発行の門（doc/designs/11-security-controls.md 11.4 / 11.8、D-29）。
 *
 * ゲストは2経路で発行されうる。
 *   1. `/home?/playAsGuest` の form action（画面の「すぐ遊ぶ」）
 *   2. `POST /api/auth/sign-in/anonymous`（better-auth が公開する HTTP 経路）
 *
 * **判定は必ずこの関数1つを通す。** 経路ごとに書くと、片方だけ守られた状態
 * （= Turnstile と回数制限の素通り）が簡単に生まれる。
 *
 * 守りは3層:
 *   1. Turnstile（Bot 判定の主要根拠。鍵未設定の development だけ素通り）
 *   2. `RL_GUEST_BURST`（IP ハッシュ単位の連打。3件/60秒）
 *   3. `GuestIssuanceGuard` DO（IP ハッシュ単位で厳密に 3件/時間）
 */

export type GuestGateResult =
	| { ok: true; decision: GuestIssuanceDecision }
	| { ok: false; status: 400 | 429; reason: 'captcha' | 'burst' | 'hourly' };

export async function guestIssuanceGate(
	event: RequestEvent,
	turnstileToken: string | undefined
): Promise<GuestGateResult> {
	const captcha = await verifyTurnstile(turnstileToken, clientIp(event.request.headers));
	if (!captcha.ok) {
		await audit(event, {
			type: 'captcha_failed',
			severity: 'warn',
			detail: { at: 'guest_issue', reason: captcha.reason }
		});
		return { ok: false, status: 400, reason: 'captcha' };
	}

	const ipHash = await ipHashOf(event);

	// ローカル開発では接続元 IP が無く、全員が同じキーへ潰れる。IP 基準の2層
	// （バースト・1時間の窓）をそのまま適用すると、検証スクリプトが数分おきにしか
	// 回せなくなる。そこで **development でかつ IP が取れないときだけ** IP 基準の
	// 制限を飛ばす。ヘッダーの有無だけで飛ばすと本番の抜け道になるため、環境の
	// 条件と必ず AND にする（検証時は `cf-connecting-ip` を付けて有効化できる）。
	const skipIpLimits =
		(env.ENVIRONMENT ?? 'development') === 'development' &&
		!event.request.headers.has('cf-connecting-ip');
	if (skipIpLimits) {
		return { ok: true, decision: { allowed: true, count: 0, retryAfterSeconds: 0 } };
	}

	if (!(await withinLimit(limiter(event, 'RL_GUEST_BURST'), ipHash))) {
		await audit(event, {
			type: 'rate_limited',
			severity: 'warn',
			detail: { at: 'guest_issue', layer: 'burst' }
		});
		return { ok: false, status: 429, reason: 'burst' };
	}

	const decision = await consumeGuestIssuance(event, ipHash);
	if (!decision.allowed) {
		await audit(event, {
			type: 'guest_issuance_blocked',
			severity: 'warn',
			detail: { count: decision.count, retryAfterSeconds: decision.retryAfterSeconds }
		});
		return { ok: false, status: 429, reason: 'hourly' };
	}
	return { ok: true, decision };
}

/** ゲスト発行の成功を記録する（発行元の経路を detail に残す）。 */
export async function auditGuestIssued(
	event: RequestEvent,
	userId: string | null,
	via: 'form' | 'api',
	decision: GuestIssuanceDecision
): Promise<void> {
	await audit(event, {
		type: 'guest_issued',
		severity: 'info',
		userId,
		detail: {
			via,
			count: decision.count,
			// 既にセッションを持つ端末からの追加発行は補助シグナルとして残すだけ
			// （正当な家族共有もあるため、単独で拒否の根拠にしない。11.8.3）。
			hadSession: event.request.headers.has('cookie')
		}
	});
}

/** better-auth が公開する匿名サインインの HTTP 経路。 */
const ANONYMOUS_ENDPOINT = '/api/auth/sign-in/anonymous';

/**
 * 画面を経由しないゲスト発行にも同じ門を適用する hook。
 *
 * Turnstile のトークンは `x-captcha-response` ヘッダーで受け取る（better-auth の
 * captcha プラグインと同じ名前。ボディを読むと better-auth 側が読めなくなるため）。
 */
export const handleGuestIssuance: Handle = async ({ event, resolve }) => {
	if (event.request.method !== 'POST' || event.url.pathname !== ANONYMOUS_ENDPOINT) {
		return resolve(event);
	}

	const gate = await guestIssuanceGate(
		event,
		event.request.headers.get('x-captcha-response') ?? undefined
	);
	if (!gate.ok) {
		return errorResponse(
			gate.status,
			gate.status === 429 ? 'E_RATE_LIMITED' : 'E_FORBIDDEN',
			gate.reason === 'captcha' ? '確認に失敗しました' : 'ゲストの発行が多すぎます'
		);
	}

	const response = await resolve(event);
	if (response.ok) {
		// 応答本文は better-auth のものをそのまま返す。監査のためだけに覗く。
		const clone = response.clone();
		const body = (await clone.json().catch(() => null)) as { user?: { id?: string } } | null;
		await auditGuestIssued(event, body?.user?.id ?? null, 'api', gate.decision);
	}
	return response;
};
