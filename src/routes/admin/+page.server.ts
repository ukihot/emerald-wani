import { fail } from '@sveltejs/kit';
import * as v from 'valibot';
import { desc, eq } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { report, securityEvent } from '$lib/server/db/schema';
import { recordAdminAudit, requireAdmin } from '$lib/server/admin-audit';

/**
 * 運営ダッシュボード。直近のセキュリティ事象と未処理の通報を出し、通報の状態だけを
 * 更新できる（doc/designs/14-observability.md、doc/designs/11-security-controls.md 11.8.4）。
 *
 * ここでできないことを意図的に決めている:
 *   - アカウントの停止・恒久停止は置かない。段階4以上は人間の承認と記録の様式が要る
 *     （doc/designs/15-incident-response.md）。画面から1クリックで到達させない。
 *   - 監査ログの更新・削除の導線を作らない（追記専用。T-DATA-03）。
 *   - 進行中の試合の内容は見られない（終局後のリプレイのみ。10.4）。
 *
 * **閲覧そのものを `admin_audit` に記録する**（誰がいつ誰のログを見たか）。
 */

const ROW_LIMIT = 50;

export const load = (async (event) => {
	const identity = requireAdmin(event);
	const db = getDb(event.platform!.env.DB);

	const [events, reports] = await Promise.all([
		db.select().from(securityEvent).orderBy(desc(securityEvent.ts)).limit(ROW_LIMIT),
		db.select().from(report).orderBy(desc(report.createdAt)).limit(ROW_LIMIT)
	]);

	await recordAdminAudit(event, {
		adminUserId: identity.userId,
		action: 'audit_log_viewed',
		targetType: 'security_event',
		detail: { events: events.length, reports: reports.length }
	});

	return {
		events: events.map((row) => ({
			id: row.id,
			ts: row.ts.getTime(),
			type: row.type,
			severity: row.severity,
			userId: row.userId,
			detail: row.detailJson
		})),
		reports: reports.map((row) => ({
			id: row.id,
			createdAt: row.createdAt.getTime(),
			targetUserId: row.targetUserId,
			reason: row.reason,
			status: row.status
		}))
	};
}) satisfies PageServerLoad;

const UpdateSchema = v.strictObject({
	reportId: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
	status: v.picklist(['reviewing', 'actioned', 'dismissed'])
});

export const actions = {
	/** 通報の状態だけを変える。制裁そのものはここから行わない。 */
	updateReport: async (event) => {
		const identity = requireAdmin(event);
		const form = await event.request.formData();
		const parsed = v.safeParse(UpdateSchema, {
			reportId: form.get('reportId')?.toString() ?? '',
			status: form.get('status')?.toString() ?? ''
		});
		if (!parsed.success) return fail(400, { message: 'invalid request' });

		const db = getDb(event.platform!.env.DB);
		await db
			.update(report)
			.set({ status: parsed.output.status })
			.where(eq(report.id, parsed.output.reportId));

		await recordAdminAudit(event, {
			adminUserId: identity.userId,
			action: 'report_status_changed',
			targetType: 'report',
			targetId: parsed.output.reportId,
			detail: { status: parsed.output.status }
		});

		return { updated: true };
	}
} satisfies Actions;
