import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { createGame, isSupportedMapVersion, isSupportedRuleVersion } from '../game/index';
import type { GameState, Seat } from '../game/types';
import { dispatchCommand } from './command';
import { parseReplay } from './replay';
import type { Command } from './ws';

/**
 * 過去版リプレイの互換テスト（doc/designs/19-testing.md 5節、D-25）。
 *
 * `fixtures/` の NDJSON は**実運用と同じ形式で保存した過去の対局**である。
 * ルールエンジンに手を入れたとき、保存済みリプレイが同じ最終状態・同じ Event を
 * 再現できなくなったら、そのリプレイは再生不能になっている。
 *
 * 落ちたときに取る道は2つしかない。
 *   1. 変更が意図せず互換を壊している → 変更を直す。
 *   2. 意図してルールを変えた → 新しい `RULE_VERSION` を切り、旧版の reducer を
 *      版数レジストリへ残す。**fixture を作り直して通すのは誤り**（過去の対局が
 *      再生できなくなる）。
 */

const dir = new URL('./fixtures/', import.meta.url);
const files = readdirSync(dir).filter((name) => name.endsWith('.ndjson'));

describe('過去版リプレイの互換', () => {
	it('fixture が存在する', () => {
		expect(files.length).toBeGreaterThan(0);
	});

	for (const file of files) {
		it(`${file} を再生すると保存時と同じ結末になる`, () => {
			const replay = parseReplay(readFileSync(new URL(file, dir), 'utf8'));
			const { header, entries } = replay;

			// 版数レジストリから消えたリプレイは再生できない（D-25）。
			expect(isSupportedRuleVersion(header.ruleVersion)).toBe(true);
			expect(isSupportedMapVersion(header.mapVersion)).toBe(true);

			let state: GameState = createGame(header.seed);
			expect(state.mapVersion).toBe(header.mapVersion);
			expect(state.ruleVersion).toBe(header.ruleVersion);
			expect(state.firstSeat).toBe(header.firstSeat);

			for (const entry of entries) {
				const result = dispatchCommand(
					state,
					entry.actorSeat as Seat,
					entry.command as unknown as Command
				);
				if (!result.ok) {
					throw new Error(`rev ${entry.rev} が再生できない: ${result.error}`);
				}
				state = result.value.state;
				// Event は派生物だが、表示・監査の見え方が変わるのも互換の破壊である。
				expect(result.value.events.map((event) => `${event.type}:${event.message}`)).toEqual(
					entry.events.map((event) => `${event.type}:${event.message}`)
				);
			}

			const winnerSeat = state.winner === 'draw' || state.winner === null ? null : state.winner;
			expect(winnerSeat).toBe(header.winnerSeat);
			expect(state.endReason).toBe(header.endReason);
			expect([state.score[0], state.score[1]]).toEqual(header.score);
			expect(state.round).toBe(header.roundCount);
			expect(state.phase).toBe('finished');
		});
	}
});
