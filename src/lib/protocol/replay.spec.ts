import { describe, expect, it } from 'vitest';
import {
	REPLAY_FORMAT_VERSION,
	gunzip,
	gzip,
	parseReplay,
	replayObjectKey,
	serializeReplay,
	type Replay
} from './replay';

/** doc/designs/09-api-protocol.md 4節のリプレイ形式。 */

const replay: Replay = {
	header: {
		v: REPLAY_FORMAT_VERSION,
		matchId: '0198f0a0-1111-7000-8000-000000000001',
		mode: 'ranked_random',
		ruleVersion: 'rules-1.0.0',
		mapVersion: 'map-7x9-v1',
		seed: 'deadbeef',
		firstSeat: 0,
		startedAt: 1_700_000_000_000,
		endedAt: 1_700_000_600_000,
		winnerSeat: 1,
		endReason: 'concede',
		score: [1, 3],
		roundCount: 7,
		seats: [
			{ seat: 0, userId: 'user-a', result: 'loss' },
			{ seat: 1, userId: 'user-b', result: 'win' }
		]
	},
	entries: [
		{
			rev: 1,
			ts: 1_700_000_000_000,
			actorSeat: null,
			command: { type: 'sys.startMatch', seed: 'deadbeef' },
			events: []
		},
		{
			rev: 2,
			ts: 1_700_000_010_000,
			actorSeat: 0,
			command: { type: 'submitDeployment', placements: [] },
			events: [{ type: 'deployment', message: '布陣を確定しました。' }]
		}
	]
};

describe('replay', () => {
	it('NDJSON の1行目がヘッダ、2行目以降が Command 明細になる', () => {
		const lines = serializeReplay(replay).trimEnd().split('\n');
		expect(lines).toHaveLength(3);
		expect(JSON.parse(lines[0]).v).toBe(REPLAY_FORMAT_VERSION);
		expect(JSON.parse(lines[1]).rev).toBe(1);
	});

	it('直列化と復元で内容が変わらない', () => {
		expect(parseReplay(serializeReplay(replay))).toEqual(replay);
	});

	it('壊れた行は例外にする', () => {
		expect(() => parseReplay('{"v":99}')).toThrow();
		expect(() => parseReplay('')).toThrow();
	});

	it('R2 のキーは終局時刻の年月で分かれる', () => {
		expect(replayObjectKey('abc', Date.UTC(2026, 8, 3))).toBe(
			'replays/2026/09/abc/match.ndjson.gz'
		);
	});

	it('gzip した内容を復元できる', async () => {
		const text = serializeReplay(replay);
		const compressed = await gzip(text);
		expect(compressed.byteLength).toBeLessThan(new TextEncoder().encode(text).byteLength);
		expect(await gunzip(compressed)).toBe(text);
	});
});
