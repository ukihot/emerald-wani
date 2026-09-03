import { describe, expect, it } from 'vitest';
import {
	completeDeployment,
	createGame,
	deploymentCellOrder,
	findLeakedOpponentPositions,
	projectState,
	submitDeployment,
	suggestedDeployment
} from './index';
import type { Seat } from './types';

const OTHER: Record<Seat, Seat> = { 0: 1, 1: 0 };

describe('座席視点への射影', () => {
	it('布陣中は相手の配置が一切漏れない（100 seed）', () => {
		for (let index = 0; index < 100; index += 1) {
			const seed = `VIEW-${index}`;
			let state = createGame(seed);

			// 片方だけ確定した直後が最も漏洩しやすい瞬間。
			const seat0Result = submitDeployment(state, 0, suggestedDeployment(state, 0));
			expect(seat0Result.ok).toBe(true);
			if (!seat0Result.ok) continue;
			state = seat0Result.value.state;

			for (const seat of [0, 1] as const) {
				const view = projectState(state, seat);
				expect(findLeakedOpponentPositions(view, seat)).toEqual([]);
			}

			// 自分自身の配置は常に見えていなければならない（過剰な秘匿にしない）。
			const ownView = projectState(state, 0);
			const ownPlaced = Object.values(ownView.pieces).filter(
				(piece) => piece.owner === 0 && piece.position !== null
			);
			expect(ownPlaced).toHaveLength(8);

			// 両者確定・公開後は完全情報になる。
			const seat1Result = submitDeployment(state, 1, suggestedDeployment(state, 1));
			expect(seat1Result.ok).toBe(true);
			if (!seat1Result.ok) continue;
			state = seat1Result.value.state;
			expect(state.phase).toBe('playing');

			for (const seat of [0, 1] as const) {
				const view = projectState(state, seat);
				const opponentPlaced = Object.values(view.pieces).filter(
					(piece) => piece.owner === OTHER[seat] && piece.position !== null
				);
				expect(opponentPlaced).toHaveLength(8);
			}
		}
	});

	it('時間切れの自動配置（未確定分の補完）でも布陣中は漏れない', () => {
		const state = createGame('VIEW-TIMEOUT');
		const partial = suggestedDeployment(state, 0).slice(0, 3);
		const completed = completeDeployment(state, 0, partial);
		const result = submitDeployment(state, 0, completed);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(findLeakedOpponentPositions(projectState(result.value.state, 1), 1)).toEqual([]);
	});

	it('射影は自分の未使用配置マスの一覧など、盤面情報自体は変えない', () => {
		const state = createGame('VIEW-BOARD');
		const view = projectState(state, 0);
		expect(view.board).toBe(state.board);
		expect(deploymentCellOrder(view, 0)).toEqual(deploymentCellOrder(state, 0));
	});
});
