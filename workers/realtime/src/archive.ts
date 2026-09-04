import {
	gzip,
	replayObjectKey,
	serializeReplay,
	type ReplayEntry,
	type ReplayHeader
} from '$protocol/replay';

/**
 * 終局後の永続化（doc/designs/07-durable-objects.md 9.2、doc/designs/09-api-protocol.md 4節）。
 *
 * ```
 * MatchRoom DO --(matchId のみ)--> Queue --> consumer
 *   consumer -> DO /internal/export        （ログ本体の取得）
 *   consumer -> R2                          （完全版リプレイ 1本）
 *   consumer -> D1 match / match_player     （UPSERT。matchId が冪等キー）
 *   consumer -> DO /internal/archive-complete
 * ```
 *
 * Queue には `matchId` だけを送る（メッセージ上限 128KB を避けるため）。
 * Cloudflare Queues 無料プランはメッセージを24時間しか保持しないため、Queue の
 * リトライだけに頼らず、Cron が `match.replay_key IS NULL` の行を直接拾い直す
 * （doc/designs/03-tech-stack.md 4.3）。どちらの経路も同じ `archiveMatch` を呼ぶ。
 */

export interface ArchiveJob {
	matchId: string;
}

/** Cron が1回のスキャンで再試行する上限。無料プランの操作数を圧迫しない範囲に抑える。 */
export const ARCHIVE_RETRY_BATCH = 20;

/**
 * 終局した対戦の結果を D1 へ書く。リプレイ本体（`replay_key`）はまだ埋めない。
 *
 * MatchRoom が終局直後に呼び、consumer も冪等に呼び直す。`match` は `id` を、
 * `match_player` は `(match_id, seat)` を冪等キーとして UPSERT する。
 */
export async function upsertMatchResult(env: Env, header: ReplayHeader): Promise<void> {
	const statements = [
		env.DB.prepare(
			`INSERT INTO match
			   (id, mode, rule_version, map_version, map_seed, status, winner_seat, end_reason,
			    round_count, score_seat0, score_seat1, started_at, ended_at, replay_key)
			 VALUES (?, ?, ?, ?, ?, 'finished', ?, ?, ?, ?, ?, ?, ?, NULL)
			 ON CONFLICT(id) DO UPDATE SET
			   status = excluded.status,
			   winner_seat = excluded.winner_seat,
			   end_reason = excluded.end_reason,
			   round_count = excluded.round_count,
			   score_seat0 = excluded.score_seat0,
			   score_seat1 = excluded.score_seat1,
			   ended_at = excluded.ended_at`
		).bind(
			header.matchId,
			header.mode,
			header.ruleVersion,
			header.mapVersion,
			header.seed,
			header.winnerSeat,
			header.endReason,
			header.roundCount,
			header.score[0],
			header.score[1],
			header.startedAt,
			header.endedAt
		),
		...header.seats.map((seat) =>
			env.DB.prepare(
				`INSERT INTO match_player (match_id, seat, user_id, result)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(match_id, seat) DO UPDATE SET result = excluded.result`
			).bind(header.matchId, seat.seat, seat.userId, seat.result)
		)
	];
	await env.DB.batch(statements);
}

/**
 * 1試合をアーカイブする。すでに完了している場合も安全に再実行できる
 * （R2 は同じキーへ上書き、D1 は UPSERT、DO への完了通知も冪等）。
 */
export async function archiveMatch(env: Env, matchId: string): Promise<'archived' | 'skipped'> {
	const stub = env.MATCH_ROOM.get(env.MATCH_ROOM.idFromName(matchId));

	const exported = await stub.fetch('http://match-room.internal/internal/export');
	if (exported.status === 409) {
		// まだ終局していない。Queue の重複配信や Cron の取りこぼしで起こりうる。
		return 'skipped';
	}
	if (!exported.ok) {
		throw new Error(`export failed: HTTP ${exported.status}`);
	}
	const { header, entries } = (await exported.json()) as {
		header: ReplayHeader;
		entries: ReplayEntry[];
	};

	const key = replayObjectKey(header.matchId, header.endedAt ?? header.startedAt);
	const body = await gzip(serializeReplay({ header, entries }));

	try {
		await env.REPLAYS.put(key, body, {
			httpMetadata: { contentType: 'application/x-ndjson', contentEncoding: 'gzip' },
			customMetadata: { matchId: header.matchId, ruleVersion: header.ruleVersion }
		});
		await upsertMatchResult(env, header);
		await env.DB.prepare(`UPDATE match SET replay_key = ? WHERE id = ?`)
			.bind(key, header.matchId)
			.run();
	} catch (error) {
		await notifyArchiveFailed(stub, error);
		throw error;
	}

	await stub.fetch('http://match-room.internal/internal/archive-complete', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ replayKey: key })
	});
	return 'archived';
}

async function notifyArchiveFailed(stub: DurableObjectStub, error: unknown): Promise<void> {
	try {
		await stub.fetch('http://match-room.internal/internal/archive-failed', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ error: error instanceof Error ? error.message : 'unknown' })
		});
	} catch (notifyError) {
		console.error('failed to report archive failure to MatchRoom', notifyError);
	}
}

/**
 * アーカイブ未完了の対戦を D1 から探す（Cron のフォールバック）。
 *
 * `match` 行は MatchRoom が終局直後に書くため、Queue メッセージが失われても
 * ここで発見できる。終局直後の行は consumer が処理中の可能性が高いので、
 * 一定時間（`minAgeMs`）経過したものだけを対象にする。
 */
export async function findUnarchivedMatchIds(
	env: Env,
	now: number,
	minAgeMs: number
): Promise<string[]> {
	const result = await env.DB.prepare(
		`SELECT id FROM match
		 WHERE replay_key IS NULL AND ended_at IS NOT NULL AND ended_at < ?
		 ORDER BY ended_at ASC
		 LIMIT ?`
	)
		.bind(now - minAgeMs, ARCHIVE_RETRY_BATCH)
		.all<{ id: string }>();
	return (result.results ?? []).map((row) => row.id);
}
