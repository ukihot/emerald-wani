import { error, fail, redirect } from '@sveltejs/kit';
import * as v from 'valibot';
import type { Actions, PageServerLoad } from './$types';
import { dbFrom } from '$lib/server/api/identity';
import { findMatchDetailForUser, resolveReportTarget } from '$lib/server/api/matches';
import { report } from '$lib/server/db/schema';
import { REPORT_REASONS } from '$lib/protocol/report';
import { m } from '$lib/paraglide/messages';

/**
 * 対戦結果の詳細とリプレイ、通報導線（doc/designs/17-frontend.md 1節）。
 *
 * 参加者でなければ 404 を返す（存在の有無を漏らさない。
 * doc/designs/10-auth-and-access.md 10.3）。リプレイ本体は
 * `GET /api/v1/matches/{id}/replay` からクライアントが取得する。
 */

const ReportSchema = v.strictObject({
	targetSeat: v.union([v.literal(0), v.literal(1)]),
	reason: v.picklist(REPORT_REASONS)
});

export const load = (async (event) => {
	const { user } = event.locals;
	if (!user) return redirect(303, '/home');

	const detail = await findMatchDetailForUser(dbFrom(event), event.params.id, user.id);
	if (!detail) throw error(404, m.error_match_not_found());
	return { match: detail };
}) satisfies PageServerLoad;

export const actions = {
	/**
	 * 通報（doc/designs/11-security-controls.md 11.8.4）。
	 * REST の `POST /api/v1/reports` と同じ規約で動く（対象は座席で指定する）。
	 */
	report: async (event) => {
		const { user } = event.locals;
		if (!user) return redirect(303, '/home');

		const form = await event.request.formData();
		const parsed = v.safeParse(ReportSchema, {
			targetSeat: Number(form.get('targetSeat')),
			reason: form.get('reason')?.toString()
		});
		if (!parsed.success) return fail(400, { message: m.error_report_invalid() });

		const db = dbFrom(event);
		const target = await resolveReportTarget(db, {
			matchId: event.params.id,
			reporterUserId: user.id,
			targetSeat: parsed.output.targetSeat
		});
		if (!target) throw error(404, m.error_match_not_found());

		// 同一の（通報者・対象・対戦）は1件に畳む。二重送信も成功として返す。
		await db
			.insert(report)
			.values({
				id: crypto.randomUUID(),
				reporterUserId: user.id,
				targetUserId: target.targetUserId,
				matchId: event.params.id,
				reason: parsed.output.reason
			})
			.onConflictDoNothing();

		return { reported: true };
	}
} satisfies Actions;
