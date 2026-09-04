import { json } from '@sveltejs/kit';
import * as v from 'valibot';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/auth-guard';
import { errorResponse } from '$lib/server/api/responses';
import { getDb } from '$lib/server/db';
import { report } from '$lib/server/db/schema';
import { resolveReportTarget } from '$lib/server/api/matches';
import { REPORT_REASONS } from '$lib/protocol/report';

/**
 * POST /api/v1/reports — 通報（doc/designs/11-security-controls.md 11.8.4）。
 *
 * 認可: anonymous+。**ゲストも通報でき、ゲストも通報対象になる。** 設計文書 09 の表は
 * `user` と書いているが、11.8.4 の「ゲストだから通報できない・されない状態を作らない」
 * が優先する（そうしないと悪質な行為をゲスト経由へ誘導してしまう）。
 *
 * 対象は `targetSeat` で指定する。ユーザ ID をリクエストから受け取らないため、
 * 総当たりで他人の ID を指定することができない（doc/designs/10-auth-and-access.md 10.3）。
 * 自由記述は受け取らず、固定の理由コードだけを保存する。
 *
 * 同一の（通報者・対象・対戦）は1件に畳む。二重送信でも成功として返し、
 * 「既に通報済みか」を通報者に伝えない（嫌がらせの探索に使わせない）。
 * 通報は自動制裁に直結させず、運営が人手で判断する。
 */

const BodySchema = v.strictObject({
	matchId: v.pipe(v.string(), v.regex(/^[0-9a-f-]{36}$/i)),
	targetSeat: v.union([v.literal(0), v.literal(1)]),
	reason: v.picklist(REPORT_REASONS)
});

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	const { user } = requireUser(locals);
	if (!platform?.env?.DB) return errorResponse(500, 'E_INTERNAL', 'データベースに接続できません');

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return errorResponse(400, 'E_MALFORMED', 'リクエストが不正です');
	}
	const parsed = v.safeParse(BodySchema, body);
	if (!parsed.success) return errorResponse(400, 'E_MALFORMED', 'リクエストが不正です');

	const db = getDb(platform.env.DB);
	const target = await resolveReportTarget(db, {
		matchId: parsed.output.matchId,
		reporterUserId: user.id,
		targetSeat: parsed.output.targetSeat
	});
	// 参加していない対戦、自分自身、空席のいずれも「対戦が見つからない」として返す。
	if (!target) return errorResponse(404, 'E_NOT_FOUND', '対戦が見つかりません');

	await db
		.insert(report)
		.values({
			id: crypto.randomUUID(),
			reporterUserId: user.id,
			targetUserId: target.targetUserId,
			matchId: parsed.output.matchId,
			reason: parsed.output.reason
		})
		.onConflictDoNothing();

	return json({ status: 'received' }, { status: 202 });
};
