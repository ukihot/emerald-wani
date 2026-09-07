import { sequence } from '@sveltejs/kit/hooks';
import { building } from '$app/environment';
import { createAuth } from '$lib/server/auth';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import type { Handle } from '@sveltejs/kit';
import { getTextDirection } from '$lib/paraglide/runtime';
import { paraglideMiddleware } from '$lib/paraglide/server';
import { applySecurityHeaders } from '$lib/server/security-headers';
import { handleApiRateLimit } from '$lib/server/api-rate-limit';
import { handleGuestIssuance } from '$lib/server/guest-issuance';

/**
 * セキュリティヘッダーの一括付与（doc/designs/11-security-controls.md 11.1）。
 * CSP 自体は `kit.csp`（vite.config.ts）が nonce 付きで組み立てる。ここでは
 * 残りのヘッダーを足し、`/admin/**` の CSP から Turnstile の許可を外す。
 */
const handleSecurityHeaders: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	applySecurityHeaders(response.headers, event.url.pathname);
	return response;
};

const handleParaglide: Handle = ({ event, resolve }) =>
	paraglideMiddleware(event.request, ({ request, locale }) => {
		event.request = request;

		return resolve(event, {
			transformPageChunk: ({ html }) =>
				html
					.replace('%paraglide.lang%', locale)
					.replace('%paraglide.dir%', getTextDirection(locale))
		});
	});

const handleBetterAuth: Handle = async ({ event, resolve }) => {
	if (!event.platform?.env?.DB)
		throw new Error('D1 binding "DB" not found - are you running with wrangler?');

	event.locals.auth = createAuth(event.platform.env.DB, event.platform.env.ORIGIN);

	const { auth } = event.locals;
	const session = await auth.api.getSession({ headers: event.request.headers });

	if (session) {
		event.locals.session = session.session;
		event.locals.user = session.user;
	}

	return svelteKitHandler({ event, resolve, auth, building });
};

/**
 * 順序が意味を持つ。
 *   - ヘッダー付与は最も外側（エラー応答を含む全応答に掛けるため）
 *   - ゲスト発行の門は better-auth **より前**（`svelteKitHandler` は `/api/auth/**` を
 *     自分で処理して後続の hook を呼ばないため、後ろに置くと素通りする）
 *   - API のレート制限は better-auth の後ろ（`locals.user` をキーに使うため）
 */
export const handle: Handle = sequence(
	handleSecurityHeaders,
	handleParaglide,
	handleGuestIssuance,
	handleBetterAuth,
	handleApiRateLimit
);
