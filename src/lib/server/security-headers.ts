/**
 * HTTP レスポンスヘッダー（doc/designs/11-security-controls.md 11.1）。
 *
 * CSP 本体は SvelteKit の `kit.csp`（mode: 'nonce'）が組み立てて付ける。ここでは
 * それ以外のヘッダーを一括で足し、`/admin/**` だけ CSP を締め直す。
 */

export const SECURITY_HEADERS: Record<string, string> = {
	'X-Content-Type-Options': 'nosniff',
	'Referrer-Policy': 'same-origin',
	'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
	'Cross-Origin-Opener-Policy': 'same-origin',
	'Cross-Origin-Resource-Policy': 'same-origin',
	'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload'
};

/** Turnstile を読み込む必要がある画面の許可先。 */
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

/**
 * 管理画面用に CSP を締める（11.1 末尾）。管理画面は Turnstile を使わないため、
 * `script-src` / `frame-src` から `challenges.cloudflare.com` を落とし、
 * 空になった `frame-src` は `'none'` にする（ディレクティブごと消すと
 * `default-src 'none'` に落ちるが、意図を明示するために残す）。
 */
export function tightenAdminCsp(csp: string): string {
	return csp
		.split(';')
		.map((directive) => directive.trim())
		.filter(Boolean)
		.map((directive) => {
			if (!directive.includes(TURNSTILE_ORIGIN)) return directive;
			const cleaned = directive
				.split(/\s+/)
				.filter((token) => token !== TURNSTILE_ORIGIN)
				.join(' ');
			// ソースが1つも残らなかった（= Turnstile 専用の frame-src だった）場合。
			return cleaned.includes(' ') ? cleaned : `${cleaned} 'none'`;
		})
		.join('; ');
}

/** すべての応答へ適用する。CSP の締め直しは `/admin/**` のみ。 */
export function applySecurityHeaders(headers: Headers, pathname: string): void {
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);

	if (pathname === '/admin' || pathname.startsWith('/admin/')) {
		const csp = headers.get('content-security-policy');
		if (csp) headers.set('content-security-policy', tightenAdminCsp(csp));
	}
}
