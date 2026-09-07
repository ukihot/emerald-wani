import type { Handle } from '@sveltejs/kit';
import { audit, ipHashOf } from '$lib/server/security';
import { limiter, rateLimitedResponse, withinLimit } from '$lib/server/rate-limit';

/**
 * REST API のバースト制限（doc/designs/11-security-controls.md 11.4）。
 *
 * 各ルートに書き足すのではなく hook で1か所にまとめる。エンドポイントが増えても
 * 読み取り API は既定で `RL_API_READ` に入り、掛け忘れが起きない。
 * 認証系フォーム（`RL_AUTH`）はここではなく `$lib/server/auth-gate.ts` が見る。
 *
 * キーはユーザ ID、未認証なら日次ソルト付きの IP ハッシュ。**生 IP は使わない。**
 */

type Binding = 'RL_MATCHMAKING' | 'RL_REPORT_WRITE' | 'RL_WS_TICKET' | 'RL_API_READ';

const RULES: { method: string; pattern: RegExp; binding: Binding }[] = [
	{ method: 'POST', pattern: /^\/api\/v1\/matchmaking\/enqueue\/?$/, binding: 'RL_MATCHMAKING' },
	{ method: 'POST', pattern: /^\/api\/v1\/reports\/?$/, binding: 'RL_REPORT_WRITE' },
	{ method: 'POST', pattern: /^\/api\/v1\/matches\/[^/]+\/ws-ticket\/?$/, binding: 'RL_WS_TICKET' },
	{ method: 'GET', pattern: /^\/api\/v1\//, binding: 'RL_API_READ' }
];

/** 最初に一致した規則を返す。該当しなければ制限しない。 */
export function matchRule(pathname: string, method: string): Binding | null {
	return (
		RULES.find((rule) => rule.method === method && rule.pattern.test(pathname))?.binding ?? null
	);
}

export const handleApiRateLimit: Handle = async ({ event, resolve }) => {
	const binding = matchRule(event.url.pathname, event.request.method);
	if (!binding) return resolve(event);

	const key = event.locals.user?.id ?? (await ipHashOf(event));
	if (await withinLimit(limiter(event, binding), key)) return resolve(event);

	await audit(event, {
		type: 'rate_limited',
		severity: 'warn',
		detail: { binding, path: event.url.pathname }
	});
	return rateLimitedResponse();
};
