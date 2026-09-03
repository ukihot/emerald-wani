import { describe, expect, it } from 'vitest';
import {
	actionForCell,
	applyAction,
	cellId,
	createGame,
	legalActionsForPiece,
	pieceId,
	submitDeployment,
	suggestedDeployment
} from './index';
import type { CrocodileKind, GameAction, GameState, Position, Seat } from './types';

function arena(): GameState {
	let state = createGame('interaction-seed');
	for (const seat of [1, 0] as const) {
		const result = submitDeployment(state, seat, suggestedDeployment(state, seat));
		if (!result.ok) throw new Error(result.error);
		state = result.value.state;
	}
	for (const cell of state.board.cells) {
		if (cell.terrain !== 'nest') cell.terrain = 'normal';
	}
	for (const piece of Object.values(state.pieces)) {
		piece.position = null;
		piece.captiveId = null;
		piece.capturedBy = null;
		piece.removed = true;
		piece.movedThisTurn = false;
		piece.transportedThisTurn = false;
		piece.jumpedThisTurn = false;
	}
	state.activeSeat = 0;
	state.vitality = [2, 0];
	state.positionCounts = {};
	return state;
}

function place(state: GameState, seat: Seat, kind: CrocodileKind, position: Position) {
	const piece = state.pieces[pieceId(seat, kind)];
	piece.position = position;
	piece.removed = false;
	return piece;
}

/** ヌシワニ(0)を中央に、敵コワニ(1)をその真北の隣接マスに置いた盤面。 */
function scenario(): { state: GameState; actions: GameAction[] } {
	const state = arena();
	place(state, 0, 'nushi', { x: 3, y: 4 });
	place(state, 1, 'kowa', { x: 3, y: 3 });
	return { state, actions: legalActionsForPiece(state, pieceId(0, 'nushi')) };
}

describe('マスと行動の対応', () => {
	it('合法手の対象マスだけが行動を持つ（空きマス全部が光らない）', () => {
		const { state, actions } = scenario();

		const highlighted = state.board.cells.filter((cell) => {
			const occupant = Object.values(state.pieces).find(
				(piece) => !piece.removed && piece.position && cellId(piece.position) === cell.id
			);
			return actionForCell(actions, cell.id, occupant?.id) !== undefined;
		});

		// ヌシワニは周囲8方向へ1マス。北隣は敵が占有しているので移動先は7マス、
		// そこへ噛みつき対象の1マスを足した8マスだけが対象になる。
		expect(highlighted).toHaveLength(8);
		expect(highlighted.length).toBeLessThan(state.board.cells.length);
	});

	it('押したマスの行動を返す（先頭の行動へフォールバックしない）', () => {
		const { actions } = scenario();

		// 生成順の先頭は東(4:4)への移動。南(3:5)を押したら南の移動が返らなければならない。
		expect(actions[0]?.toCellId).toBe('4:4');

		const south = actionForCell(actions, '3:5', undefined);
		expect(south?.type).toBe('move');
		expect(south?.toCellId).toBe('3:5');
	});

	it('移動先ではない空きマスは行動を持たない', () => {
		const { actions } = scenario();

		for (const far of ['0:0', '6:8', '0:8', '3:0']) {
			expect(actionForCell(actions, far, undefined)).toBeUndefined();
		}
	});

	it('隣接する敵のマスは噛みつきを返す', () => {
		const { actions } = scenario();

		const bite = actionForCell(actions, '3:3', pieceId(1, 'kowa'));
		expect(bite?.type).toBe('bite');
		expect(bite?.targetPieceId).toBe(pieceId(1, 'kowa'));
	});

	it('「駒を選ぶ→敵のマスを押す」操作で実際に捕獲できる', () => {
		const { state, actions } = scenario();

		// UI と同じ経路: クリックされたマスから行動を引き、そのまま applyAction へ渡す。
		const bite = actionForCell(actions, '3:3', pieceId(1, 'kowa'));
		expect(bite).toBeDefined();
		const result = applyAction(state, bite!);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const attacker = result.value.state.pieces[pieceId(0, 'nushi')];
		const captive = result.value.state.pieces[pieceId(1, 'kowa')];
		expect(attacker.captiveId).toBe(pieceId(1, 'kowa'));
		expect(attacker.position).toEqual({ x: 3, y: 3 });
		expect(captive.capturedBy).toBe(pieceId(0, 'nushi'));
		expect(captive.position).toBeNull();
	});

	it('駒がいないマスに噛みつきを誤って割り当てない', () => {
		const bite: GameAction = {
			type: 'bite',
			pieceId: pieceId(0, 'nushi'),
			cost: 1,
			label: '噛みつき',
			targetPieceId: pieceId(1, 'kowa')
		};

		expect(actionForCell([bite], '3:3', undefined)).toBeUndefined();
		expect(actionForCell([bite], '3:3', pieceId(1, 'kowa'))).toBe(bite);
	});

	it('捕食はマスに紐づかない', () => {
		const feed: GameAction = {
			type: 'feed',
			pieceId: pieceId(0, 'katsugi'),
			cost: 2,
			label: '捕食'
		};

		expect(actionForCell([feed], '3:8', undefined)).toBeUndefined();
		expect(actionForCell([feed], '3:8', pieceId(0, 'katsugi'))).toBeUndefined();
	});
});
