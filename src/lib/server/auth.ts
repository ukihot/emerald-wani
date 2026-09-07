import { env } from '$env/dynamic/private';
import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { anonymous } from 'better-auth/plugins/anonymous';
import { admin } from 'better-auth/plugins/admin';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { haveIBeenPwned } from 'better-auth/plugins/haveibeenpwned';
import { getRequestEvent } from '$app/server';
import type { D1Database } from '@cloudflare/workers-types';
import { eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { playerProfile, user as userTable } from '$lib/server/db/schema';
import { generateGuestDisplayName } from '$lib/server/guest-name';
import { migrateAnonymousAccount } from '$lib/server/account-migration';
import {
	resetPasswordEmail,
	sendEmail,
	verificationEmail,
	type EmailConfig
} from '$lib/server/email';

/**
 * better-auth の構成。
 *
 * フェーズ5（アカウントと履歴）で `anonymous` に加え、メール+パスワードの本登録、
 * 確認メール、パスワード再設定、匿名からのデータ移行を有効化した。
 *
 * フェーズ6（セキュリティ強化）で `admin`（役割・アカウント停止）、`twoFactor`
 * （管理者の MFA 必須化。doc/designs/10-auth-and-access.md 10.4）、`haveIBeenPwned`
 * （流出パスワードの拒否。T-AUTH-01）を追加した。Turnstile は `captcha` プラグインを
 * 使わない: 認証画面は SvelteKit の form actions から `auth.api.*` を直接呼んでおり、
 * `/api/auth/**` を通らないため同プラグインの `onRequest` が発火しない。加えてゲスト
 * 発行にも Turnstile を掛ける必要があり、その経路はプラグインの対象外である。
 * 代わりに `$lib/server/turnstile.ts` の検証を各 form action の先頭で呼ぶ。
 *
 * 重要な前提: ゲストは「検証の緩い経路」ではなく **匿名の認証済みユーザー** である。
 * 認可・不正対策・監査は本登録ユーザーと同一に適用する
 * （doc/designs/01-principles.md 3、doc/designs/10-auth-and-access.md）。
 */

/** 本登録ユーザーのセッション有効期限（doc/designs/10-auth-and-access.md 10.2）。 */
const REGISTERED_SESSION_SECONDS = 60 * 60 * 24 * 30;

/** ゲストのセッション有効期限。失効後は復元しない。 */
const GUEST_SESSION_SECONDS = 60 * 60 * 24 * 7;

/** セッションのローリング更新間隔。 */
const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24;

/** 確認メールのトークン有効期限。 */
const VERIFICATION_TOKEN_SECONDS = 60 * 60;

/** 再設定トークンの有効期限（doc/designs/10-auth-and-access.md: 推奨15分・単回使用）。 */
const RESET_TOKEN_SECONDS = 15 * 60;

function emailConfigFromEnv(): EmailConfig {
	return {
		apiKey: env.RESEND_API_KEY,
		from: env.EMAIL_FROM,
		// ローカル開発以外では「ログに出して成功扱い」のフォールバックを禁じる。
		requireProvider: (env.ENVIRONMENT ?? 'development') !== 'development'
	};
}

export const createAuth = (d1: D1Database, baseURL: string) => {
	const db = getDb(d1);

	return betterAuth({
		secret: env.BETTER_AUTH_SECRET,
		baseURL,
		database: drizzleAdapter(db, { provider: 'sqlite' }),

		emailAndPassword: {
			enabled: true,
			minPasswordLength: 8,
			// 確認メールは送るが、未確認でもログインと対戦は妨げない。
			// 「すぐ遊べること」もセキュリティ要件であり（doc/designs/01-principles.md 3）、
			// ゲストから昇格した直後に対戦導線が切れるのを避ける。掲載・報酬など
			// 確認済みを要求すべき機能はフェーズ6以降で個別に判断する。
			requireEmailVerification: false,
			resetPasswordTokenExpiresIn: RESET_TOKEN_SECONDS,
			sendResetPassword: async ({ user, url }) => {
				await sendEmail(emailConfigFromEnv(), { to: user.email, ...resetPasswordEmail(url) });
			}
		},

		emailVerification: {
			sendOnSignUp: true,
			autoSignInAfterVerification: true,
			expiresIn: VERIFICATION_TOKEN_SECONDS,
			sendVerificationEmail: async ({ user, url }) => {
				await sendEmail(emailConfigFromEnv(), { to: user.email, ...verificationEmail(url) });
			}
		},

		session: {
			expiresIn: REGISTERED_SESSION_SECONDS,
			updateAge: SESSION_UPDATE_AGE_SECONDS
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

		databaseHooks: {
			user: {
				create: {
					after: async (created) => {
						// 表示情報はゲスト・本登録を問わず `player_profile` に持つ。
						// 匿名→本登録の移行はこの行ごと引き継ぐ（account-migration.ts）。
						await db
							.insert(playerProfile)
							.values({ userId: created.id, displayName: created.name })
							.onConflictDoNothing();
					}
				}
			},
			session: {
				create: {
					before: async (session) => {
						// better-auth はセッション有効期限をグローバルにしか持たないため、
						// ゲストのセッションだけをここで7日へ短縮する
						// （doc/designs/10-auth-and-access.md 10.2）。
						const [owner] = await db
							.select({ isAnonymous: userTable.isAnonymous })
							.from(userTable)
							.where(eq(userTable.id, session.userId))
							.limit(1);
						if (!owner?.isAnonymous) return;
						return {
							data: {
								...session,
								expiresAt: new Date(Date.now() + GUEST_SESSION_SECONDS * 1000)
							}
						};
					}
				}
			}
		},

		plugins: [
			anonymous({
				generateName: () => generateGuestDisplayName(),

				// 匿名ユーザー行は本登録へのリンク後に削除される。削除の前に
				// `onLinkAccount` で戦績・設定を移行しているため、引き継ぎ対象は失われない
				// （doc/designs/10-auth-and-access.md「アカウント連携時のデータ移行」）。
				disableDeleteAnonymousUser: false,

				onLinkAccount: async ({ anonymousUser, newUser }) => {
					// ここで例外を投げると better-auth は匿名ユーザーを削除せずに失敗する。
					// 「移行成功後だけ削除を許可する」という設計上の要求は、この
					// 「失敗したら投げる」挙動でそのまま満たされる。
					const summary = await migrateAnonymousAccount(db, {
						anonymousUserId: anonymousUser.user.id,
						newUserId: newUser.user.id,
						newDisplayName: newUser.user.name
					});
					console.info('anonymous account migrated', {
						matches: summary.matches,
						profile: summary.profile
					});
				}
			}),
			// 役割（user / moderator / admin）とアカウント停止（doc/designs/10-auth-and-access.md 10.4）。
			// 役割の付与は D1 を直接更新して行う（管理画面から役割を配れる導線は作らない）。
			admin({ defaultRole: 'user', adminRoles: ['admin'] }),

			// 管理者の MFA。管理画面は `twoFactorEnabled` が真の管理者しか通さない
			// （src/routes/admin/+layout.server.ts）。一般ユーザーには必須化しない
			// （登録障壁。doc/designs/12-threat-model.md T-AUTH-01 の受容理由）。
			twoFactor({ issuer: 'emerald-wani' }),

			// 流出済みパスワードを登録・変更時に拒否する（k-anonymity。平文は送らない）。
			haveIBeenPwned(),

			sveltekitCookies(getRequestEvent) // 必ず配列の最後に置く
		]
	});
};

/**
 * DO NOT USE!
 *
 * This instance is used by the `auth` CLI for schema generation ONLY.
 * To access `auth` at runtime, use `event.locals.auth`.
 */
export const auth = createAuth(null!, env.ORIGIN || 'http://localhost:5173');
