import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { user } from './auth.schema';

/**
 * 対戦・戦績・通報のテーブル（doc/designs/08-data-model.md）。
 *
 * 設計上の要点:
 *   - 対戦中の正は MatchRoom DO の内蔵 SQLite。ここには **終局後の結果だけ**を書く。
 *   - Command / Event の明細は D1 に入れず、R2 のリプレイ（`replay_key`）へ書き出す。
 *   - `rule_version` / `map_version` / `map_seed` を保持し、同じ盤面で再現できるようにする。
 *   - 個人情報は better-auth の `user` 以外へ複製しない（表示名だけを `player_profile` に持つ）。
 */

/** 表示情報とクライアント設定。匿名→本登録の移行時にこの行ごと引き継ぐ。 */
export const playerProfile = sqliteTable('player_profile', {
	userId: text('user_id')
		.primaryKey()
		.references(() => user.id, { onDelete: 'cascade' }),
	displayName: text('display_name').notNull(),
	iconId: text('icon_id'),
	/** クライアント設定（音量・演出軽減・言語）。スキーマはクライアント側で検証する。 */
	settingsJson: text('settings_json').notNull().default('{}'),
	createdAt: integer('created_at', { mode: 'timestamp_ms' })
		.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
		.notNull()
});

/**
 * 終局した対戦の結果。
 *
 * `replay_key` が NULL の行は「結果は確定したがリプレイの永続化が未完了」を意味し、
 * アーカイブ再試行（Cron）の対象になる（doc/designs/03-tech-stack.md 4.3）。
 */
export const match = sqliteTable(
	'match',
	{
		/** MatchQueue が採番する UUIDv7 相当のランダム ID。 */
		id: text('id').primaryKey(),
		mode: text('mode').notNull(),
		ruleVersion: text('rule_version').notNull(),
		mapVersion: text('map_version').notNull(),
		mapSeed: text('map_seed').notNull(),
		/** finished | void */
		status: text('status').notNull(),
		winnerSeat: integer('winner_seat'),
		endReason: text('end_reason'),
		roundCount: integer('round_count').notNull().default(0),
		scoreSeat0: integer('score_seat0').notNull().default(0),
		scoreSeat1: integer('score_seat1').notNull().default(0),
		startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
		endedAt: integer('ended_at', { mode: 'timestamp_ms' }),
		/** R2 のオブジェクトキー。未アーカイブのあいだは NULL。 */
		replayKey: text('replay_key')
	},
	(table) => [
		index('match_endedAt_idx').on(table.endedAt),
		index('match_version_status_idx').on(table.ruleVersion, table.mapVersion, table.status),
		index('match_replayKey_idx').on(table.replayKey)
	]
);

/** 参加者と結果。`user_id` は匿名→本登録の移行で付け替わる。 */
export const matchPlayer = sqliteTable(
	'match_player',
	{
		matchId: text('match_id')
			.notNull()
			.references(() => match.id, { onDelete: 'cascade' }),
		seat: integer('seat').notNull(),
		/**
		 * `user` への外部キーは張らない。匿名ユーザーの行が削除されても戦績を失わないため
		 * （移行は `onLinkAccount` で明示的に行う。doc/designs/10-auth-and-access.md）。
		 */
		userId: text('user_id').notNull(),
		/** win | loss | draw */
		result: text('result').notNull()
	},
	(table) => [
		uniqueIndex('match_player_pk').on(table.matchId, table.seat),
		index('match_player_userId_matchId_idx').on(table.userId, table.matchId)
	]
);

/**
 * 通報（doc/designs/11-security-controls.md 11.8.4）。
 *
 * ゲストも通報でき、ゲストも通報対象になる。自動制裁には直結させず、運営が判断する。
 * 同一の通報者・対象・対戦の組は1件に畳む（組織的な虚偽通報への耐性）。
 * 自由記述は受け取らず、固定の理由コードだけを保存する。
 */
export const report = sqliteTable(
	'report',
	{
		id: text('id').primaryKey(),
		reporterUserId: text('reporter_user_id').notNull(),
		targetUserId: text('target_user_id').notNull(),
		matchId: text('match_id'),
		reason: text('reason').notNull(),
		/** open | reviewing | actioned | dismissed */
		status: text('status').notNull().default('open'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull()
	},
	(table) => [
		uniqueIndex('report_reporter_target_match_uidx').on(
			table.reporterUserId,
			table.targetUserId,
			table.matchId
		),
		index('report_target_createdAt_idx').on(table.targetUserId, table.createdAt),
		index('report_status_createdAt_idx').on(table.status, table.createdAt)
	]
);
