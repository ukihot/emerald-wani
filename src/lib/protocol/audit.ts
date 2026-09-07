/**
 * 監査ログの共有部（doc/designs/14-observability.md 1節）。
 *
 * web と realtime の両ワーカーから同じ形式で `security_event` へ追記するため、
 * SvelteKit にも Drizzle にも依存しない素の D1 呼び出しで書く（realtime 側は
 * `$protocol/audit` として読む。依存方向は realtime -> src/lib の一方向）。
 *
 * 記録してはならない項目（14.1.3）: Cookie、パスワード、トークン、WSチケット、
 * メールアドレス、公開前の相手布陣、**生の IP と生の User-Agent**。
 * IP / UA は日次でローテートするソルト付き HMAC の結果だけを保存する。
 */

export const SECURITY_EVENT_TYPES = [
	// 認証
	'guest_issued',
	'guest_issuance_blocked',
	'captcha_failed',
	'login_failed',
	// 認可・API
	'rate_limited',
	'forbidden_access',
	// 対戦
	'ws_auth_failed',
	'ws_invalid_flood',
	// 運営
	'admin_login',
	'admin_action',
	'audit_log_viewed',
	// 基盤
	'archive_failed'
] as const;

export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];

export type Severity = 'info' | 'warn' | 'error' | 'critical';

export interface SecurityEventInput {
	type: SecurityEventType;
	severity: Severity;
	userId?: string | null;
	ipHash?: string | null;
	uaHash?: string | null;
	/** 相関に使う付随情報。個人情報・資格情報を入れないこと。 */
	detail?: Record<string, unknown>;
}

/** D1 の最小インターフェース。@cloudflare/workers-types への依存を持ち込まない。 */
export interface AuditD1 {
	prepare(query: string): {
		bind(...values: unknown[]): { run(): Promise<unknown> };
	};
}

/** UTC の日付キー。ソルトはこの単位でローテートする。 */
export function dayKey(now: number): string {
	return new Date(now).toISOString().slice(0, 10);
}

/**
 * IP / User-Agent を日次ソルト付き HMAC で置き換える。
 *
 * ソルトは `secret` と日付から導出する（鍵を1本増やさずに日次ローテートを得る）。
 * 日付が変われば同じ IP でも別の値になるため、**長期の追跡は意図的に不能**である。
 * 短期（同日内）の同一性判定にだけ使える。
 */
export async function hashSignal(
	secret: string,
	value: string | null | undefined,
	now: number = Date.now()
): Promise<string | null> {
	if (!value) return null;
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const mac = await crypto.subtle.sign(
		'HMAC',
		key,
		// 用途を分離する接頭辞を必ず入れる（S-02 を他用途と混ぜないため）。
		new TextEncoder().encode(`audit-v1|${dayKey(now)}|${value}`)
	);
	// 16バイトで足りる（同日内の同一性判定にしか使わない）。
	return [...new Uint8Array(mac).slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** リクエストから IP と User-Agent の要約ハッシュを作る。生値は返さない。 */
export async function clientSignals(
	secret: string,
	headers: Headers,
	now: number = Date.now()
): Promise<{ ipHash: string | null; uaHash: string | null }> {
	const [ipHash, uaHash] = await Promise.all([
		hashSignal(secret, clientIp(headers), now),
		hashSignal(secret, headers.get('user-agent'), now)
	]);
	return { ipHash, uaHash };
}

/** Cloudflare が付ける接続元 IP。ローカル開発では欠けるので 'local' へ落とす。 */
export function clientIp(headers: Headers): string {
	return (
		headers.get('cf-connecting-ip') ?? headers.get('x-forwarded-for')?.split(',')[0] ?? 'local'
	);
}

/**
 * `security_event` へ1件追記する。**失敗してもリクエスト処理を止めない**
 * （監査の失敗で対戦や認証が落ちる方が損害が大きい。失敗自体はログに出す）。
 */
export async function recordSecurityEvent(
	db: AuditD1 | undefined,
	event: SecurityEventInput,
	now: number = Date.now()
): Promise<void> {
	if (!db) return;
	try {
		await db
			.prepare(
				`INSERT INTO security_event (id, ts, type, severity, user_id, ip_hash, ua_hash, detail_json)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				crypto.randomUUID(),
				now,
				event.type,
				event.severity,
				event.userId ?? null,
				event.ipHash ?? null,
				event.uaHash ?? null,
				JSON.stringify(event.detail ?? {})
			)
			.run();
	} catch (error) {
		console.error('security_event insert failed', event.type, error);
	}
}

/**
 * 重大度 error 以上を運営の通知先へ送る（doc/designs/14-observability.md 3節）。
 * 通知の失敗はリクエスト処理を妨げない。呼び出し側は `ctx.waitUntil()` に載せること。
 */
export async function notifyAlert(
	webhookUrl: string | undefined,
	event: SecurityEventInput
): Promise<void> {
	if (!webhookUrl) return;
	if (event.severity !== 'error' && event.severity !== 'critical') return;
	try {
		await fetch(webhookUrl, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				text: `[${event.severity}] ${event.type} ${JSON.stringify(event.detail ?? {})}`
			})
		});
	} catch (error) {
		console.error('alert notification failed', error);
	}
}

/** 記録と通知をまとめて行う（通知は severity で絞られる）。 */
export async function auditAndAlert(
	db: AuditD1 | undefined,
	webhookUrl: string | undefined,
	event: SecurityEventInput,
	now: number = Date.now()
): Promise<void> {
	await recordSecurityEvent(db, event, now);
	await notifyAlert(webhookUrl, event);
}
