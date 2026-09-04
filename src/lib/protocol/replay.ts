import * as v from 'valibot';
import type { GameEvent, Seat } from '../game/types';

/**
 * リプレイのファイル形式（doc/designs/09-api-protocol.md 4節）。
 *
 * `replays/{yyyy}/{mm}/{matchId}/match.ndjson.gz` に gzip した NDJSON を1本保存する。
 * 1行目がヘッダ、2行目以降が Command 1件ごとの明細。
 *
 * **ヘッダと Command 列が正本**であり、`events` は監査・表示用の派生物である。
 * `seed` と `ruleVersion` / `mapVersion` があれば盤面と進行を再生成できる。
 *
 * 終局後は布陣も含めて完全情報のため、座席別にファイルを分けない
 * （布陣フェーズ中のライブ配信だけが座席別射影を必要とする）。
 */

/** 現行のリプレイ形式版数。設計文書の例に合わせて 2 から始める。 */
export const REPLAY_FORMAT_VERSION = 2;

export const ReplayHeaderSchema = v.object({
	v: v.literal(REPLAY_FORMAT_VERSION),
	matchId: v.string(),
	mode: v.string(),
	ruleVersion: v.string(),
	mapVersion: v.string(),
	seed: v.string(),
	firstSeat: v.union([v.literal(0), v.literal(1)]),
	startedAt: v.number(),
	endedAt: v.nullable(v.number()),
	winnerSeat: v.nullable(v.union([v.literal(0), v.literal(1)])),
	endReason: v.nullable(v.string()),
	score: v.tuple([v.number(), v.number()]),
	roundCount: v.number(),
	/**
	 * 座席と参加者の対応。終局後の閲覧者に必要なのは座席の識別だけなので、
	 * 表示名やメールアドレスは書き出さない（doc/designs/09-api-protocol.md 4節）。
	 */
	seats: v.array(
		v.object({
			seat: v.union([v.literal(0), v.literal(1)]),
			userId: v.string(),
			result: v.string()
		})
	)
});
export type ReplayHeader = v.InferOutput<typeof ReplayHeaderSchema>;

export const ReplayEntrySchema = v.object({
	rev: v.number(),
	ts: v.number(),
	actorSeat: v.nullable(v.union([v.literal(0), v.literal(1)])),
	command: v.record(v.string(), v.unknown()),
	events: v.array(v.object({ type: v.string(), message: v.string() }))
});
export type ReplayEntry = {
	rev: number;
	ts: number;
	actorSeat: Seat | null;
	command: Record<string, unknown>;
	events: GameEvent[];
};

export interface Replay {
	header: ReplayHeader;
	entries: ReplayEntry[];
}

/** R2 のオブジェクトキー。終局時刻（UTC）で年月に分ける。 */
export function replayObjectKey(matchId: string, endedAt: number): string {
	const date = new Date(endedAt);
	const year = String(date.getUTCFullYear()).padStart(4, '0');
	const month = String(date.getUTCMonth() + 1).padStart(2, '0');
	return `replays/${year}/${month}/${matchId}/match.ndjson.gz`;
}

export function serializeReplay(replay: Replay): string {
	return [replay.header, ...replay.entries].map((line) => JSON.stringify(line)).join('\n') + '\n';
}

/** NDJSON を検証しながら読む。壊れた行があれば例外を投げる。 */
export function parseReplay(text: string): Replay {
	const lines = text.split('\n').filter((line) => line.trim().length > 0);
	if (lines.length === 0) throw new Error('empty replay');

	const header = v.parse(ReplayHeaderSchema, JSON.parse(lines[0]));
	const entries = lines.slice(1).map((line) => {
		v.parse(ReplayEntrySchema, JSON.parse(line));
		return JSON.parse(line) as ReplayEntry;
	});
	return { header, entries };
}

/**
 * gzip / gunzip。`Blob` を経由せず `Response` の body ストリームを使う。
 * ブラウザ・Workers・Node のいずれでも同じ型で通り、全体をメモリに二重展開しない。
 */
export async function gzip(text: string): Promise<Uint8Array> {
	const source = new Response(text).body;
	if (!source) throw new Error('gzip: empty body');
	const stream = source.pipeThrough(new CompressionStream('gzip'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzip(data: ArrayBuffer | Uint8Array): Promise<string> {
	const source = new Response(data as ArrayBuffer).body;
	if (!source) throw new Error('gunzip: empty body');
	return new Response(source.pipeThrough(new DecompressionStream('gzip'))).text();
}
