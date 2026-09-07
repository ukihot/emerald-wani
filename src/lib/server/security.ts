import { env } from '$env/dynamic/private';
import type { RequestEvent } from '@sveltejs/kit';
import {
	auditAndAlert,
	clientIp,
	clientSignals,
	type SecurityEventInput
} from '$lib/protocol/audit';

/**
 * `ip_hash` / `ua_hash` のソルト元（doc/designs/13-secrets-lifecycle.md S-06）。
 *
 * 日次ローテートは秘密そのものを毎日入れ替えるのではなく、日付を HMAC の入力に
 * 混ぜて実現する（$lib/protocol/audit.ts の hashSignal）。realtime Worker も同じ値を
 * 持ち、両ワーカーのハッシュが同日内で突き合わせられるようにする。
 */
export function auditSecret(): string {
	return env.AUDIT_SALT_SECRET || 'development-audit-salt';
}

/**
 * リクエストから監査記録を1件書く（doc/designs/14-observability.md）。
 *
 * `user_id` は locals から補い、IP / UA は日次ソルト付き HMAC にしてから渡す。
 * 記録は待つ（D1 への1 INSERT）。`waitUntil` に逃がすと、記録前に DO や Worker の
 * 実行が終わった場合に取りこぼす。重大度 error 以上は通知先へも送る。
 */
export async function audit(
	event: RequestEvent,
	input: Omit<SecurityEventInput, 'ipHash' | 'uaHash'>
): Promise<void> {
	const { ipHash, uaHash } = await clientSignals(auditSecret(), event.request.headers);
	await auditAndAlert(event.platform?.env?.DB, env.ALERT_WEBHOOK_URL, {
		userId: event.locals.user?.id ?? null,
		...input,
		ipHash,
		uaHash
	});
}

/** レート制限・ゲスト発行ガードのキーに使う、日次ソルト付きの IP ハッシュ。 */
export async function ipHashOf(event: RequestEvent): Promise<string> {
	const { ipHash } = await clientSignals(auditSecret(), event.request.headers);
	return ipHash ?? 'local';
}

export { clientIp };
