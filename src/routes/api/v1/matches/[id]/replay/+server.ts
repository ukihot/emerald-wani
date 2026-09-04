import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/auth-guard';
import { errorResponse } from '$lib/server/api/responses';
import { getDb } from '$lib/server/db';
import { findReplayKeyForUser } from '$lib/server/api/matches';

/**
 * GET /api/v1/matches/{id}/replay — リプレイを認可後に配信する。
 *
 * R2 は公開せず、認可した Worker だけがストリーム配信する
 * （doc/designs/09-api-protocol.md 1節）。保存形式は gzip した NDJSON なので、
 * `Content-Encoding: gzip` を付けたまま素通しし、Worker 側では展開しない。
 *
 * 参加者でなければ 404（存在の有無を漏らさない）。参加者だがアーカイブが
 * 未完了のあいだは 202 を返し、クライアントに再試行の余地を示す。
 */

const MATCH_ID_PATTERN = /^[0-9a-f-]{36}$/i;

export const GET: RequestHandler = async ({ params, locals, platform }) => {
	const { user } = requireUser(locals);
	if (!platform?.env?.DB || !platform.env.REPLAYS) {
		return errorResponse(500, 'E_INTERNAL', 'リプレイ機能が利用できません');
	}

	const matchId = params.id;
	if (!matchId || !MATCH_ID_PATTERN.test(matchId)) {
		return errorResponse(404, 'E_NOT_FOUND', '対戦が見つかりません');
	}

	const { participant, replayKey } = await findReplayKeyForUser(
		getDb(platform.env.DB),
		matchId,
		user.id
	);
	if (!participant) return errorResponse(404, 'E_NOT_FOUND', '対戦が見つかりません');
	if (!replayKey) {
		return json({ status: 'pending', message: 'リプレイを準備しています' }, { status: 202 });
	}

	const object = await platform.env.REPLAYS.get(replayKey);
	if (!object) {
		// D1 は archived を指しているのに R2 に無い＝アーカイブの不整合。
		console.error('replay object missing', replayKey);
		return errorResponse(404, 'E_NOT_FOUND', 'リプレイが見つかりません');
	}

	return new Response(object.body as unknown as ReadableStream, {
		headers: {
			'content-type': 'application/x-ndjson; charset=utf-8',
			'content-encoding': 'gzip',
			'cache-control': 'private, max-age=300'
		}
	});
};
