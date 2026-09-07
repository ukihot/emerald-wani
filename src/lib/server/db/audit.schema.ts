import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * 監査ログ（doc/designs/08-data-model.md 1節、doc/designs/14-observability.md 1節）。
 *
 * **追記専用。** 更新・削除の手段は API に実装しない（T-DATA-03）。保持期間超過分の
 * 削除は運用バッチだけが行い、その実行自体も `admin_audit` へ記録する。
 *
 * 生の IP / User-Agent は保存しない。日次ローテートするソルトで HMAC した
 * `ip_hash` / `ua_hash` だけを持つ（$lib/protocol/audit.ts）。
 */

/** セキュリティ事象。書き込むのは web / realtime の両ワーカー。 */
export const securityEvent = sqliteTable(
	'security_event',
	{
		id: text('id').primaryKey(),
		ts: integer('ts', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		/** 事象の種別（$lib/protocol/audit.ts の SecurityEventType）。 */
		type: text('type').notNull(),
		/** info | warn | error | critical */
		severity: text('severity').notNull(),
		/** 未認証時は NULL。匿名ユーザーも記録する。 */
		userId: text('user_id'),
		ipHash: text('ip_hash'),
		uaHash: text('ua_hash'),
		/** 相関 ID・対戦 ID・件数など。個人情報と資格情報は入れない。 */
		detailJson: text('detail_json').notNull().default('{}')
	},
	(table) => [
		index('security_event_ts_idx').on(table.ts),
		index('security_event_userId_ts_idx').on(table.userId, table.ts),
		index('security_event_type_ts_idx').on(table.type, table.ts)
	]
);

/** 運営操作履歴。ログの閲覧自体も記録する（doc/designs/14-observability.md 1.4）。 */
export const adminAudit = sqliteTable(
	'admin_audit',
	{
		id: text('id').primaryKey(),
		ts: integer('ts', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		adminUserId: text('admin_user_id').notNull(),
		action: text('action').notNull(),
		targetType: text('target_type'),
		targetId: text('target_id'),
		detailJson: text('detail_json').notNull().default('{}')
	},
	(table) => [
		index('admin_audit_ts_idx').on(table.ts),
		index('admin_audit_admin_ts_idx').on(table.adminUserId, table.ts)
	]
);
