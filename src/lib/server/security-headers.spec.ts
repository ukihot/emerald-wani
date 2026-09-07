import { describe, expect, it } from 'vitest';
import { applySecurityHeaders, tightenAdminCsp } from './security-headers';

/** SvelteKit（kit.csp）が実際に付ける形の CSP。 */
const CSP =
	"default-src 'none'; script-src 'self' 'nonce-abc123' https://challenges.cloudflare.com; " +
	"style-src 'self' 'unsafe-inline'; frame-src https://challenges.cloudflare.com; " +
	"img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; " +
	"base-uri 'none'; form-action 'self'; object-src 'none'";

describe('tightenAdminCsp', () => {
	const tightened = tightenAdminCsp(CSP);

	it('管理画面では Turnstile の許可を落とす', () => {
		expect(tightened).not.toContain('challenges.cloudflare.com');
	});

	it('script-src の nonce 方式は崩さない', () => {
		expect(tightened).toContain("script-src 'self' 'nonce-abc123'");
	});

	it('空になった frame-src は none にする（黙って消さない）', () => {
		expect(tightened).toContain("frame-src 'none'");
	});

	it('他のディレクティブはそのまま残る', () => {
		expect(tightened).toContain("default-src 'none'");
		expect(tightened).toContain("style-src 'self' 'unsafe-inline'");
		expect(tightened).toContain("form-action 'self'");
	});
});

describe('applySecurityHeaders', () => {
	it('全応答に 11.1 のヘッダーを付ける', () => {
		const headers = new Headers();
		applySecurityHeaders(headers, '/home');
		expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(headers.get('Referrer-Policy')).toBe('same-origin');
		expect(headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
		expect(headers.get('Strict-Transport-Security')).toContain('max-age=31536000');
		expect(headers.get('Permissions-Policy')).toContain('geolocation=()');
	});

	it('一般の画面では CSP に触らない', () => {
		const headers = new Headers({ 'content-security-policy': CSP });
		applySecurityHeaders(headers, '/login');
		expect(headers.get('content-security-policy')).toBe(CSP);
	});

	it('/admin 配下だけ CSP を締める', () => {
		for (const path of ['/admin', '/admin/mfa']) {
			const headers = new Headers({ 'content-security-policy': CSP });
			applySecurityHeaders(headers, path);
			expect(headers.get('content-security-policy')).not.toContain('challenges.cloudflare.com');
		}
	});

	it('/administrator のような別経路を巻き込まない', () => {
		const headers = new Headers({ 'content-security-policy': CSP });
		applySecurityHeaders(headers, '/administrator');
		expect(headers.get('content-security-policy')).toBe(CSP);
	});
});
