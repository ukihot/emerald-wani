import { env } from '$env/dynamic/private';
import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { anonymous } from 'better-auth/plugins/anonymous';
import { getRequestEvent } from '$app/server';
import type { D1Database } from '@cloudflare/workers-types';
import { getDb } from '$lib/server/db';
import { generateGuestDisplayName } from '$lib/server/guest-name';

/**
 * better-auth の構成。
 *
 * フェーズ0では `anonymous` プラグインのみを入れる（doc/designs/21-roadmap.md）。
 * `admin` / `twoFactor` / `captcha` / `haveibeenpwned` はフェーズ4以降で追加する。
 *
 * 重要な前提: ゲストは「検証の緩い経路」ではなく **匿名の認証済みユーザー** である。
 * 認可・不正対策・監査は本登録ユーザーと同一に適用する
 * （doc/designs/01-principles.md 3、doc/designs/10-auth-and-access.md）。
 */

/** 本登録ユーザーのセッション有効期限（doc/designs/10-auth-and-access.md 10.2）。 */
const REGISTERED_SESSION_SECONDS = 60 * 60 * 24 * 30;

/** セッションのローリング更新間隔。 */
const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24;

const authConfig = {
	secret: env.BETTER_AUTH_SECRET,
	emailAndPassword: { enabled: true },

	session: {
		expiresIn: REGISTERED_SESSION_SECONDS,
		updateAge: SESSION_UPDATE_AGE_SECONDS
		// TODO(フェーズ4): ゲストのセッションだけ7日へ短縮する。
		// better-auth はセッション有効期限をグローバルにしか持たないため、
		// databaseHooks.session.create で isAnonymous を見て expiresAt を上書きする。
	},

	advanced: {
		// 既定値に依存せず明示する（doc/designs/10-auth-and-access.md 10.2）。
		// secure は better-auth の既定どおり本番でのみ付与される（開発は http のため）。
		defaultCookieAttributes: {
			httpOnly: true,
			sameSite: 'lax',
			path: '/'
		}
	},

	plugins: [
		anonymous({
			generateName: () => generateGuestDisplayName(),

			// フェーズ0では匿名ユーザーの自動削除を止めておく。
			// 既定では本登録へのリンク後に匿名ユーザー行が削除されるが、所有カード・デッキ・
			// 戦績の移行（onLinkAccount）はフェーズ4で実装するため、先に削除されると
			// 引き継ぎ対象が失われる。移行を実装したうえで false へ戻すこと
			// （doc/designs/10-auth-and-access.md「アカウント連携時のデータ移行」）。
			disableDeleteAnonymousUser: true
		}),
		sveltekitCookies(getRequestEvent) // 必ず配列の最後に置く
	]
} satisfies Omit<Parameters<typeof betterAuth>[0], 'database'>;

export const createAuth = (d1: D1Database, baseURL: string) =>
	betterAuth({
		...authConfig,
		baseURL,
		database: drizzleAdapter(getDb(d1), { provider: 'sqlite' })
	});

/**
 * DO NOT USE!
 *
 * This instance is used by the `auth` CLI for schema generation ONLY.
 * To access `auth` at runtime, use `event.locals.auth`.
 */
export const auth = createAuth(null!, env.ORIGIN || 'http://localhost:5173');
