import { and, eq, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { getDb } from '$lib/server/db';
import { matchPlayer, playerProfile, report } from '$lib/server/db/schema';

/**
 * 匿名ユーザーから本登録ユーザーへのデータ移行。
 *
 * better-auth の `anonymous` プラグインは、匿名アカウントを本アカウントへリンクした
 * **直後に匿名ユーザー行を削除する**（`onLinkAccount` → `internalAdapter.deleteUser`）。
 * 戦績・設定を失わないよう、削除の前にこの関数で移行する
 * （doc/designs/10-auth-and-access.md「アカウント連携時のデータ移行」）。
 *
 * **冪等性**: 全ての書き込みが `WHERE ... = anonymousUserId` を条件に持つため、
 * 2回目以降の実行では対象行が存在せず、重複行も二重更新も発生しない。設計文書の
 * 「`requestId` で冪等化」は「二重呼び出しでも重複行が発生しない」ことが目的であり、
 * 冪等キーの台帳を別に持たなくてもこの形で満たせる（台帳を持つと、台帳への書き込みと
 * 移行本体の原子性という別の問題を新たに抱える）。
 *
 * **原子性**: D1 は対話的トランザクションを持たないため、戦績（`match_player`）と
 * 設定（`player_profile`）は `db.batch()`（D1 のバッチ実行＝単一トランザクション）で
 * 一括適用する。**この2つが片方だけ移る状態を作らない**ことが設計上の要求である。
 *
 * 通報（`report`）の付け替えだけはバッチの外で先に実行する。理由は2つ:
 *   - `UPDATE OR IGNORE` が必要（移行先に同等の通報が既にある場合の一意制約衝突を
 *     無視して捨てる）で、drizzle の `db.batch()` は生 SQL 文を受け付けない。
 *   - 通報は監査の記録であり、`user_id` に外部キーを張っていないため、仮に失敗しても
 *     戦績の整合性には影響しない。
 * 先に実行するのは、ここで失敗したときに例外を投げて**匿名ユーザーの削除自体を止める**
 * ため（後段のバッチだけが成功して削除される、という順序を作らない）。
 */

export interface MigrationSummary {
	/** 付け替えた `match_player` の行数（実測ではなく移行前の件数）。 */
	matches: number;
	/** プロフィールを引き継いだか。 */
	profile: 'moved' | 'kept-existing' | 'none';
}

export async function migrateAnonymousAccount(
	db: ReturnType<typeof getDb>,
	input: {
		anonymousUserId: string;
		newUserId: string;
		/** 本登録時の表示名。匿名側のプロフィールが無いときの初期値に使う。 */
		newDisplayName: string;
	}
): Promise<MigrationSummary> {
	const { anonymousUserId, newUserId, newDisplayName } = input;
	if (anonymousUserId === newUserId) return { matches: 0, profile: 'kept-existing' };

	const [anonymousProfile] = await db
		.select()
		.from(playerProfile)
		.where(eq(playerProfile.userId, anonymousUserId))
		.limit(1);
	const [existingProfile] = await db
		.select()
		.from(playerProfile)
		.where(eq(playerProfile.userId, newUserId))
		.limit(1);
	const pendingMatches = await db
		.select({ matchId: matchPlayer.matchId })
		.from(matchPlayer)
		.where(eq(matchPlayer.userId, anonymousUserId));

	// 通報の履歴を追随させる。(reporter, target, match) の一意制約に衝突する行は
	// 移行先に同等の通報が既にある場合なので、無視して匿名側の行を捨てる。
	await db.run(
		sql`UPDATE OR IGNORE ${report} SET reporter_user_id = ${newUserId} WHERE reporter_user_id = ${anonymousUserId}`
	);
	await db.run(
		sql`UPDATE OR IGNORE ${report} SET target_user_id = ${newUserId} WHERE target_user_id = ${anonymousUserId}`
	);
	await db.delete(report).where(eq(report.reporterUserId, anonymousUserId));
	await db.delete(report).where(eq(report.targetUserId, anonymousUserId));

	// D1 の batch は「同種の要素からなる非空タプル」を要求するため、要素型を明示する。
	const statements: BatchItem<'sqlite'>[] = [
		// 戦績の付け替え。`match_player` に `user_id` の一意制約は無いため衝突しない。
		db.update(matchPlayer).set({ userId: newUserId }).where(eq(matchPlayer.userId, anonymousUserId))
	];

	// プロフィール（設定）の引き継ぎ。移行先に既にあるなら、そちらを正とする。
	let profile: MigrationSummary['profile'];
	if (!existingProfile) {
		statements.push(
			db.insert(playerProfile).values({
				userId: newUserId,
				// 表示名は本登録時のものを使う（better-auth は `name` を必須にしている）。
				// 匿名の自動生成名は引き継がない。表示名は保存されるデータであり、
				// 書き手の locale に依存する文言を既定値として書き込まない。
				displayName: newDisplayName || anonymousProfile?.displayName || newUserId.slice(0, 8),
				iconId: anonymousProfile?.iconId ?? null,
				settingsJson: anonymousProfile?.settingsJson ?? '{}'
			})
		);
		profile = anonymousProfile ? 'moved' : 'none';
	} else {
		profile = 'kept-existing';
	}
	// 匿名ユーザー行は better-auth が直後に削除する（`player_profile` は ON DELETE
	// CASCADE のため自動で消える）が、削除が無効化されている構成でも残骸を作らない。
	statements.push(db.delete(playerProfile).where(eq(playerProfile.userId, anonymousUserId)));

	await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);

	return { matches: pendingMatches.length, profile };
}

/** 表示名を解決する。プロフィールが未作成のユーザーにも既定値を返す。 */
export async function ensurePlayerProfile(
	db: ReturnType<typeof getDb>,
	userId: string,
	fallbackDisplayName: string
) {
	const [existing] = await db
		.select()
		.from(playerProfile)
		.where(eq(playerProfile.userId, userId))
		.limit(1);
	if (existing) return existing;

	await db
		.insert(playerProfile)
		.values({ userId, displayName: fallbackDisplayName })
		.onConflictDoNothing();
	const [created] = await db
		.select()
		.from(playerProfile)
		.where(eq(playerProfile.userId, userId))
		.limit(1);
	return created;
}

/** 自分が参加している対戦かどうか（一覧・詳細・リプレイの認可に使う）。 */
export async function findOwnSeat(
	db: ReturnType<typeof getDb>,
	matchId: string,
	userId: string
): Promise<number | null> {
	const [row] = await db
		.select({ seat: matchPlayer.seat })
		.from(matchPlayer)
		.where(and(eq(matchPlayer.matchId, matchId), eq(matchPlayer.userId, userId)))
		.limit(1);
	return row?.seat ?? null;
}
