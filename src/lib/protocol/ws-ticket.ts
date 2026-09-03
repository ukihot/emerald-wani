/**
 * WebSocket 接続チケットの署名・検証。
 *
 * web Worker（発行）と realtime Worker（検証）の両方から import される共有モジュール。
 * Web Crypto API（`crypto.subtle`）だけを使い、Node.js 依存を持たない。
 *
 * 設計: doc/designs/11-security-controls.md 11.2、doc/designs/13-secrets-lifecycle.md。
 *
 * ```
 * payload = { kid, mid, uid, seat, jti, exp, rv }
 * ticket  = base64url(payloadBytes) + "." + base64url(hmac(payloadBytes))
 * ```
 *
 * 署名対象は **payload を JSON 化したバイト列そのもの**。verify 側は base64url を
 * 復号して得た同じバイト列に対して HMAC を計算するため、JSON の再シリアライズによる
 * キー順の揺れは問題にならない（発行側が一度シリアライズしたバイト列を、検証側は
 * 再構築せずそのまま検証に使う）。
 */

export interface TicketPayload {
	/** 署名鍵の世代識別子（doc/designs/13-secrets-lifecycle.md）。 */
	kid: string;
	/** matchId。 */
	mid: string;
	/** 発行対象ユーザーID。 */
	uid: string;
	/** 発行時点で決定した座席。 */
	seat: 0 | 1;
	/** 単回使用を強制するための一意なID。 */
	jti: string;
	/** 有効期限（UNIX seconds）。 */
	exp: number;
	/** このチケットが有効なルール版数。 */
	rv: string;
}

export type VerifyResult =
	| { ok: true; payload: TicketPayload }
	| { ok: false; reason: 'malformed' | 'unknown_kid' | 'bad_signature' | 'expired' };

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array | null {
	try {
		const padded = value.replaceAll('-', '+').replaceAll('_', '/');
		const padding = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
		const binary = atob(padded + padding);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
		return bytes;
	} catch {
		return null;
	}
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify']
	);
}

/** チケットを発行する（web Worker が使う）。 */
export async function signTicket(payload: TicketPayload, secret: string): Promise<string> {
	const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
	const key = await importHmacKey(secret);
	const signature = await crypto.subtle.sign('HMAC', key, payloadBytes);
	return `${base64UrlEncode(payloadBytes)}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * チケットを検証する（realtime Worker / MatchRoom DO が使う）。
 *
 * `secrets` は `kid -> 秘密鍵` のマップ。鍵ローテーション中は複数世代を同時に渡せる
 * （doc/designs/13-secrets-lifecycle.md 2節）。exp の検証は呼び出し側の `now` で行う
 * （`Date.now()` を直接呼ばない。ルールエンジンと同じ規律）。
 */
export async function verifyTicket(
	ticket: string,
	secrets: Record<string, string>,
	now: number
): Promise<VerifyResult> {
	const parts = ticket.split('.');
	if (parts.length !== 2) return { ok: false, reason: 'malformed' };
	const [payloadPart, signaturePart] = parts;

	const payloadBytes = base64UrlDecode(payloadPart);
	const signatureBytes = base64UrlDecode(signaturePart);
	if (!payloadBytes || !signatureBytes) return { ok: false, reason: 'malformed' };

	let payload: TicketPayload;
	try {
		payload = JSON.parse(new TextDecoder().decode(payloadBytes));
	} catch {
		return { ok: false, reason: 'malformed' };
	}
	if (
		typeof payload?.kid !== 'string' ||
		typeof payload.mid !== 'string' ||
		typeof payload.uid !== 'string' ||
		(payload.seat !== 0 && payload.seat !== 1) ||
		typeof payload.jti !== 'string' ||
		typeof payload.exp !== 'number' ||
		typeof payload.rv !== 'string'
	) {
		return { ok: false, reason: 'malformed' };
	}

	const secret = secrets[payload.kid];
	if (!secret) return { ok: false, reason: 'unknown_kid' };

	const key = await importHmacKey(secret);
	// `new Uint8Array(...)` で具体的な ArrayBuffer 裏付きの型に揃える
	// （tsgo の型チェッカーが `base64UrlDecode` の戻り値の絞り込みを弱く推論するため）。
	const validSignature = await crypto.subtle.verify(
		'HMAC',
		key,
		new Uint8Array(signatureBytes),
		new Uint8Array(payloadBytes)
	);
	if (!validSignature) return { ok: false, reason: 'bad_signature' };

	if (now >= payload.exp * 1000) return { ok: false, reason: 'expired' };

	return { ok: true, payload };
}

/** `WS_TICKET_SECRET_V1` のようなバインディング名から `{ kid: secret }` マップを作る。 */
export function secretsFromEnv(env: Record<string, unknown>): Record<string, string> {
	const secrets: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		const match = /^WS_TICKET_SECRET_(V\d+)$/.exec(key);
		if (match && typeof value === 'string' && value.length > 0) {
			secrets[match[1].toLowerCase()] = value;
		}
	}
	return secrets;
}

/** 現在発行に使う鍵の kid。台帳の先頭世代を既定とする（doc/designs/13-secrets-lifecycle.md）。 */
export const CURRENT_TICKET_KID = 'v1';

/** チケットの有効期間（秒）。 */
export const TICKET_TTL_SECONDS = 60;
