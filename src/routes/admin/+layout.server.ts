import type { LayoutServerLoad } from './$types';
import { requireAdmin } from '$lib/server/admin-audit';

/**
 * 管理画面の入口（doc/designs/09-api-protocol.md 1節: `/admin/**` は admin のみ）。
 *
 * `/admin/mfa` だけは MFA 未設定でも通す（そこで設定させるため）。
 * CSP はここで締める側ではなく `hooks.server.ts` が `/admin/**` を見て締める。
 */
export const load = (async (event) => {
	const identity = requireAdmin(event, { allowWithoutMfa: event.url.pathname === '/admin/mfa' });
	return { role: identity.role };
}) satisfies LayoutServerLoad;
