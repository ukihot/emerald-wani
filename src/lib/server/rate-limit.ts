import type { RequestEvent } from '@sveltejs/kit';
import { errorResponse } from '$lib/server/api/responses';

/**
 * Worker のレート制限バインディング（doc/designs/11-security-controls.md 11.4）。
 *
 * これは**バースト制限にしか使えない**。`period` は 10 か 60 秒しか取れず、カウンタは
 * ロケーションごとに独立した eventually consistent な実装だからである。厳密な時間窓
 * （ゲスト発行の 3件/時間）は `GuestIssuanceGuard` DO が担当する（$lib/server/guest-guard.ts）。
 *
 * バインディングが無い環境（バインディング未設定のローカル実行など）では**通す**。
 * ここで落とすと開発が止まるだけで、守りは上位の WAF / DO 側にも重ねてある。
 */

export interface RateLimitBinding {
	limit(options: { key: string }): Promise<{ success: boolean }>;
}

export async function withinLimit(
	binding: RateLimitBinding | undefined,
	key: string
): Promise<boolean> {
	if (!binding) return true;
	try {
		const { success } = await binding.limit({ key });
		return success;
	} catch (error) {
		// バインディング側の障害でサービス全体を止めない。
		console.error('rate limit binding failed', error);
		return true;
	}
}

/** 429 の共通応答。`Retry-After` は period の上限（60秒）を伝える。 */
export function rateLimitedResponse(retryAfterSeconds = 60) {
	const response = errorResponse(429, 'E_RATE_LIMITED', 'リクエストが多すぎます');
	response.headers.set('Retry-After', String(retryAfterSeconds));
	return response;
}

/** ratelimit バインディングは `platform.env` に生えるが、型は各所で使う最小形に絞る。 */
export function limiter(
	event: RequestEvent,
	name:
		| 'RL_AUTH'
		| 'RL_GUEST_BURST'
		| 'RL_MATCHMAKING'
		| 'RL_REPORT_WRITE'
		| 'RL_WS_TICKET'
		| 'RL_API_READ'
): RateLimitBinding | undefined {
	return (event.platform?.env as Record<string, unknown> | undefined)?.[name] as
		RateLimitBinding | undefined;
}
