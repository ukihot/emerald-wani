import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit の設定。
 *
 * 用途は **マイグレーション SQL の生成（`db:generate`）** と、
 * **リモートのスキーマ確認・Studio（`db:studio`）** に限定する。
 *
 * ローカルへの適用は wrangler が行う（`db:migrate:local`）。これにより
 * ローカル開発が Cloudflare の認証情報を一切必要としない。
 * 詳細は doc/designs/04-dev-environment.md 5.4。
 */

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const databaseId = process.env.CLOUDFLARE_DATABASE_ID;
const token = process.env.CLOUDFLARE_D1_TOKEN;

// 認証情報が揃っているときだけリモート接続情報を渡す。
// `db:generate` はスキーマファイルだけを読むため、未設定でも動作させる。
const hasRemoteCredentials = Boolean(accountId && databaseId && token);

export default defineConfig({
	schema: './src/lib/server/db/schema.ts',
	out: './drizzle',
	dialect: 'sqlite',
	driver: 'd1-http',
	...(hasRemoteCredentials
		? {
				dbCredentials: {
					accountId: accountId!,
					databaseId: databaseId!,
					token: token!
				}
			}
		: {}),
	verbose: true,
	strict: true
});
