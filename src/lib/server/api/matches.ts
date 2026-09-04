import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { getDb } from '$lib/server/db';
import { match, matchPlayer, playerProfile, user } from '$lib/server/db/schema';
import { m } from '$lib/paraglide/messages';

/**
 * 戦績の読み出し（doc/designs/09-api-protocol.md 1節）。
 *
 * 認可の規約（doc/designs/10-auth-and-access.md 10.3）:
 *   - ユーザ ID は常にセッションから解決し、リクエストからは受け取らない。
 *   - 一覧のクエリは必ず `user_id` 条件を WHERE 句に持つ（後段フィルタにしない）。
 *   - 他人の対戦は 403 ではなく「存在しない」として扱う。
 */

/** 一覧の1ページあたりの上限（doc/designs/09-api-protocol.md 1節）。 */
export const MATCH_PAGE_LIMIT_MAX = 50;
export const MATCH_PAGE_LIMIT_DEFAULT = 20;

export interface MatchListItem {
	matchId: string;
	mode: string;
	seat: number;
	result: string;
	score: [number, number];
	endReason: string | null;
	roundCount: number;
	startedAt: number;
	endedAt: number | null;
	/** リプレイが利用可能か（アーカイブ完了済みか）。 */
	replayAvailable: boolean;
}

export interface MatchListPage {
	matches: MatchListItem[];
	nextCursor: string | null;
}

/** カーソルは「終局時刻 + 対戦ID」。値そのものに意味を持たせず base64url で包む。 */
export function encodeCursor(endedAt: number, matchId: string): string {
	return btoa(`${endedAt}|${matchId}`).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeCursor(cursor: string): { endedAt: number; matchId: string } | null {
	try {
		const decoded = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'));
		const separator = decoded.indexOf('|');
		if (separator < 0) return null;
		const endedAt = Number(decoded.slice(0, separator));
		const matchId = decoded.slice(separator + 1);
		if (!Number.isFinite(endedAt) || !matchId) return null;
		return { endedAt, matchId };
	} catch {
		return null;
	}
}

export async function listMatchesForUser(
	db: ReturnType<typeof getDb>,
	userId: string,
	options: { limit: number; cursor?: string | null }
): Promise<MatchListPage> {
	const limit = Math.min(Math.max(options.limit, 1), MATCH_PAGE_LIMIT_MAX);
	const cursor = options.cursor ? decodeCursor(options.cursor) : null;

	const rows = await db
		.select({
			matchId: match.id,
			mode: match.mode,
			seat: matchPlayer.seat,
			result: matchPlayer.result,
			scoreSeat0: match.scoreSeat0,
			scoreSeat1: match.scoreSeat1,
			endReason: match.endReason,
			roundCount: match.roundCount,
			startedAt: match.startedAt,
			endedAt: match.endedAt,
			replayKey: match.replayKey
		})
		.from(matchPlayer)
		.innerJoin(match, eq(match.id, matchPlayer.matchId))
		.where(
			cursor
				? and(
						eq(matchPlayer.userId, userId),
						or(
							lt(match.endedAt, new Date(cursor.endedAt)),
							and(eq(match.endedAt, new Date(cursor.endedAt)), lt(match.id, cursor.matchId))
						)
					)
				: eq(matchPlayer.userId, userId)
		)
		.orderBy(desc(match.endedAt), desc(match.id))
		.limit(limit + 1);

	const page = rows.slice(0, limit);
	const last = page.at(-1);
	const hasMore = rows.length > limit;

	return {
		matches: page.map((row) => ({
			matchId: row.matchId,
			mode: row.mode,
			seat: row.seat,
			result: row.result,
			score: [row.scoreSeat0, row.scoreSeat1] as [number, number],
			endReason: row.endReason,
			roundCount: row.roundCount,
			startedAt: row.startedAt.getTime(),
			endedAt: row.endedAt?.getTime() ?? null,
			replayAvailable: row.replayKey !== null
		})),
		nextCursor: hasMore && last?.endedAt ? encodeCursor(last.endedAt.getTime(), last.matchId) : null
	};
}

export interface MatchDetail extends MatchListItem {
	ruleVersion: string;
	mapVersion: string;
	mapSeed: string;
	winnerSeat: number | null;
	/**
	 * 相手の座席と表示名。ユーザ ID は返さない（通報は `targetSeat` で指定する。
	 * doc/designs/10-auth-and-access.md 10.3「ユーザ ID を受け取らない」）。
	 */
	opponent: { seat: number; displayName: string } | null;
}

/**
 * 対戦結果の詳細。**参加者でなければ `null`** を返す（呼び出し側は 404 にする）。
 * 所有者チェックは WHERE 句に含める。
 */
export async function findMatchDetailForUser(
	db: ReturnType<typeof getDb>,
	matchId: string,
	userId: string
): Promise<MatchDetail | null> {
	const [own] = await db
		.select({
			seat: matchPlayer.seat,
			result: matchPlayer.result,
			matchId: match.id,
			mode: match.mode,
			ruleVersion: match.ruleVersion,
			mapVersion: match.mapVersion,
			mapSeed: match.mapSeed,
			winnerSeat: match.winnerSeat,
			endReason: match.endReason,
			roundCount: match.roundCount,
			scoreSeat0: match.scoreSeat0,
			scoreSeat1: match.scoreSeat1,
			startedAt: match.startedAt,
			endedAt: match.endedAt,
			replayKey: match.replayKey
		})
		.from(matchPlayer)
		.innerJoin(match, eq(match.id, matchPlayer.matchId))
		.where(and(eq(matchPlayer.matchId, matchId), eq(matchPlayer.userId, userId)))
		.limit(1);
	if (!own) return null;

	const [opponent] = await db
		.select({
			seat: matchPlayer.seat,
			profileName: playerProfile.displayName,
			userName: user.name
		})
		.from(matchPlayer)
		.leftJoin(playerProfile, eq(playerProfile.userId, matchPlayer.userId))
		.leftJoin(user, eq(user.id, matchPlayer.userId))
		.where(and(eq(matchPlayer.matchId, matchId), sql`${matchPlayer.seat} <> ${own.seat}`))
		.limit(1);

	return {
		matchId: own.matchId,
		mode: own.mode,
		seat: own.seat,
		result: own.result,
		score: [own.scoreSeat0, own.scoreSeat1],
		endReason: own.endReason,
		roundCount: own.roundCount,
		startedAt: own.startedAt.getTime(),
		endedAt: own.endedAt?.getTime() ?? null,
		replayAvailable: own.replayKey !== null,
		ruleVersion: own.ruleVersion,
		mapVersion: own.mapVersion,
		mapSeed: own.mapSeed,
		winnerSeat: own.winnerSeat,
		opponent: opponent
			? {
					seat: opponent.seat,
					// 退会済みなどでプロフィールが無い場合も座席は表示できるようにする。
					displayName: opponent.profileName ?? opponent.userName ?? m.match_departed_player()
				}
			: null
	};
}

/**
 * リプレイ配信の認可。
 *
 * 「参加者でない」と「参加者だがアーカイブ未完了」を呼び出し側で区別できるよう、
 * 両方を返す（前者は 404、後者は 202）。所有者チェックは WHERE 句に含める。
 */
export async function findReplayKeyForUser(
	db: ReturnType<typeof getDb>,
	matchId: string,
	userId: string
): Promise<{ participant: boolean; replayKey: string | null }> {
	const [row] = await db
		.select({ replayKey: match.replayKey })
		.from(matchPlayer)
		.innerJoin(match, eq(match.id, matchPlayer.matchId))
		.where(and(eq(matchPlayer.matchId, matchId), eq(matchPlayer.userId, userId)))
		.limit(1);
	if (!row) return { participant: false, replayKey: null };
	return { participant: true, replayKey: row.replayKey };
}

export interface RecordSummary {
	total: number;
	wins: number;
	losses: number;
	draws: number;
}

export async function summarizeRecord(
	db: ReturnType<typeof getDb>,
	userId: string
): Promise<RecordSummary> {
	const rows = await db
		.select({ result: matchPlayer.result, count: sql<number>`count(*)` })
		.from(matchPlayer)
		.where(eq(matchPlayer.userId, userId))
		.groupBy(matchPlayer.result);

	const summary: RecordSummary = { total: 0, wins: 0, losses: 0, draws: 0 };
	for (const row of rows) {
		const count = Number(row.count);
		summary.total += count;
		if (row.result === 'win') summary.wins += count;
		else if (row.result === 'loss') summary.losses += count;
		else summary.draws += count;
	}
	return summary;
}

/** 通報対象の解決。参加者でない対戦、または存在しない座席なら `null`。 */
export async function resolveReportTarget(
	db: ReturnType<typeof getDb>,
	input: { matchId: string; reporterUserId: string; targetSeat: number }
): Promise<{ targetUserId: string } | null> {
	const seats = await db
		.select({ seat: matchPlayer.seat, userId: matchPlayer.userId })
		.from(matchPlayer)
		.where(
			and(
				eq(matchPlayer.matchId, input.matchId),
				inArray(matchPlayer.seat, [input.targetSeat, 0, 1])
			)
		);
	const reporter = seats.find((row) => row.userId === input.reporterUserId);
	if (!reporter) return null; // 参加していない対戦の通報は受け付けない

	const target = seats.find((row) => row.seat === input.targetSeat);
	if (!target || target.userId === input.reporterUserId) return null;
	return { targetUserId: target.userId };
}
