import { error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { m } from '$lib/paraglide/messages';

/**
 * 画面（`+page.server.ts`）から D1 を使うための小さな入口。
 *
 * REST ハンドラと同じく、ユーザ ID は必ずセッションから解決する
 * （doc/designs/10-auth-and-access.md 10.3）。
 */
export function dbFrom(event: Pick<RequestEvent, 'platform'>) {
	if (!event.platform?.env?.DB) throw error(500, m.error_database_unavailable());
	return getDb(event.platform.env.DB);
}

/**
 * ゲストか本登録かの判定。
 *
 * `isAnonymous` は `anonymous` プラグインが `user` テーブルへ足す列で、better-auth が
 * 公開する `User` 型には現れない（プラグインの追加列はセッション経由で実体として
 * 返るが、型としては合成されない）。ここで一箇所に閉じ込めてキャストする。
 */
export function isGuest(user: unknown): boolean {
	return Boolean((user as { isAnonymous?: boolean | null } | null | undefined)?.isAnonymous);
}
