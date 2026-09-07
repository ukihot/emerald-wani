import type { RequestEvent } from '@sveltejs/kit';

/**
 * `GuestIssuanceGuard` DO への呼び出し（doc/designs/11-security-controls.md 11.4、D-29）。
 *
 * DO の ID は `idFromName(ipHash)`。**生 IP は渡さない**（日次ソルトで HMAC 済みの値）。
 * 判定と記録を DO 側の1呼び出しで済ませ、同時リクエストのすり抜けを防ぐ。
 */

export interface GuestIssuanceDecision {
	allowed: boolean;
	count: number;
	retryAfterSeconds: number;
}

export async function consumeGuestIssuance(
	event: RequestEvent,
	ipHash: string
): Promise<GuestIssuanceDecision> {
	const ns = event.platform?.env?.GUEST_GUARD;
	// バインディングが無い環境では止めない（守りは Turnstile とバースト制限にも重ねてある）。
	if (!ns) return { allowed: true, count: 0, retryAfterSeconds: 0 };
	const stub = ns.get(ns.idFromName(ipHash));
	const response = await stub.fetch('http://guest-guard.internal/consume', { method: 'POST' });
	return (await response.json()) as GuestIssuanceDecision;
}
