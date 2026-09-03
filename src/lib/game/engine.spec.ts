import { describe, expect, it } from 'vitest';
import {
	CROCODILES,
	MAP_VERSION,
	RULE_VERSION,
	VERSION_REGISTRY,
	allLegalActions,
	applyAction,
	cellId,
	completeDeployment,
	createGame,
	deploymentCellOrder,
	endTurn,
	generateBoard,
	legalActionsForPiece,
	normalizedPosition,
	pieceId,
	runCpuTurn,
	submitDeployment,
	suggestedDeployment,
	validateBoard
} from './index';
import type { CrocodileKind, GameState, Position, Seat } from './types';

function readyGame(seed = 'test-seed'): GameState {
	let state = createGame(seed);
	const north = submitDeployment(state, 1, suggestedDeployment(state, 1));
	if (!north.ok) throw new Error(north.error);
	state = north.value.state;
	const south = submitDeployment(state, 0, suggestedDeployment(state, 0));
	if (!south.ok) throw new Error(south.error);
	state = south.value.state;
	return state;
}

function arena(): GameState {
	const state = readyGame();
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

describe('盤面生成', () => {
	it('同じseedから同じ有効盤面を生成する', () => {
		const first = generateBoard('emerald');
		const second = generateBoard('emerald');

		expect(second).toEqual(first);
		expect(validateBoard(first)).toEqual({ valid: true, errors: [] });
		expect(first.cells.filter((cell) => cell.terrain === 'tree').length).toBeGreaterThan(0);
		expect(first.cells.filter((cell) => cell.terrain === 'swamp').length).toBeGreaterThan(0);
	});

	it('異なるseedでは生成地形が変わる', () => {
		expect(generateBoard('alpha').cells).not.toEqual(generateBoard('bravo').cells);
	});

	it('1000個のseedで全生成条件を維持する', () => {
		for (let index = 0; index < 1000; index += 1) {
			const seed = `seed-${index}`;
			const board = generateBoard(seed);
			expect(validateBoard(board), seed).toEqual({ valid: true, errors: [] });
			expect(
				board.cells.filter((cell) => cell.terrain === 'void'),
				seed
			).toHaveLength(2);
			expect(
				board.cells.filter((cell) => cell.terrain === 'tree'),
				seed
			).toHaveLength(4);
			expect(
				board.cells.filter((cell) => cell.terrain === 'swamp'),
				seed
			).toHaveLength(4);
			expect(
				board.cells
					.filter((cell) => cell.terrain === 'void')
					.every((cell) => cell.x === 0 || cell.x === 6),
				seed
			).toBe(true);
		}
	});

	it('正式版のルールとマップが版数レジストリに登録されている', () => {
		expect(VERSION_REGISTRY.rules[RULE_VERSION].status).toBe('active');
		expect(VERSION_REGISTRY.maps[MAP_VERSION].status).toBe('active');
	});
});

describe('布陣とターン', () => {
	it('両者の8体確定後に先手1活力で開始する', () => {
		const state = readyGame();

		expect(state.phase).toBe('playing');
		expect(Object.values(state.pieces).filter((piece) => piece.position).length).toBe(16);
		expect(state.activeSeat).toBe(0);
		expect(state.vitality).toEqual([1, 0]);
	});

	it('先手初手の終了後から各ターン2活力になる', () => {
		const firstEnd = endTurn(readyGame());
		expect(firstEnd.ok).toBe(true);
		if (!firstEnd.ok) return;
		expect(firstEnd.value.state.vitality).toEqual([0, 2]);

		const secondEnd = endTurn(firstEnd.value.state);
		expect(secondEnd.ok).toBe(true);
		if (!secondEnd.ok) return;
		expect(secondEnd.value.state.round).toBe(2);
		expect(secondEnd.value.state.vitality).toEqual([2, 0]);
	});

	it('自動配置は手動配置を保持して未配置分だけ補う', () => {
		const state = createGame();
		const partial = [
			{ kind: 'kowa' as const, cellId: '0:8' },
			{ kind: 'nushi' as const, cellId: '6:8' }
		];
		const completed = completeDeployment(state, 0, partial);

		expect(completed).toHaveLength(8);
		expect(completed).toEqual(expect.arrayContaining(partial));
		expect(new Set(completed.map((placement) => placement.cellId)).size).toBe(8);
		expect(deploymentCellOrder(state, 0).slice(0, 3)).toEqual(['3:7', '2:7', '4:7']);
	});
});

describe('固有移動と噛みつき', () => {
	it('ヌシワニは斜めへ移動・噛みつきできる', () => {
		const state = arena();
		const nushi = place(state, 0, 'nushi', { x: 3, y: 4 });
		const enemy = place(state, 1, 'kowa', { x: 4, y: 3 });
		const actions = legalActionsForPiece(state, nushi.id);

		expect(actions.some((item) => item.type === 'move' && item.toCellId === '2:3')).toBe(true);
		expect(actions.some((item) => item.type === 'bite' && item.targetPieceId === enemy.id)).toBe(
			true
		);
	});

	it('通常の特殊ワニは前後左右だけに1マス移動する', () => {
		for (const kind of ['katsugi', 'pocha', 'biyoon'] as const) {
			const state = arena();
			const piece = place(state, 0, kind, { x: 3, y: 4 });
			const moves = legalActionsForPiece(state, piece.id).filter((item) => item.type === 'move');
			expect(moves.map((item) => item.toCellId).sort(), kind).toEqual(['2:4', '3:3', '3:5', '4:4']);
		}
	});

	it('ナナメワニは途中が空いている場合だけ斜め2マス移動できる', () => {
		const state = arena();
		const naname = place(state, 0, 'naname', { x: 3, y: 4 });
		expect(
			legalActionsForPiece(state, naname.id).some(
				(item) => item.type === 'move' && item.toCellId === '5:2'
			)
		).toBe(true);

		place(state, 0, 'kowa', { x: 4, y: 3 });
		expect(
			legalActionsForPiece(state, naname.id).some(
				(item) => item.type === 'move' && item.toCellId === '5:2'
			)
		).toBe(false);
	});

	it('セッカチワニは移動したターンに噛めない', () => {
		const state = arena();
		const sekkachi = place(state, 0, 'sekkachi', { x: 3, y: 4 });
		const enemy = place(state, 1, 'kowa', { x: 3, y: 3 });
		sekkachi.movedThisTurn = true;

		expect(
			legalActionsForPiece(state, sekkachi.id).some(
				(item) => item.type === 'bite' && item.targetPieceId === enemy.id
			)
		).toBe(false);
	});

	it('セッカチワニは前後左右へ最大2マス移動し、斜め移動しない', () => {
		const state = arena();
		const sekkachi = place(state, 0, 'sekkachi', { x: 3, y: 4 });
		const moves = legalActionsForPiece(state, sekkachi.id).filter((item) => item.type === 'move');
		expect(moves).toHaveLength(8);
		expect(moves.some((item) => item.toCellId === '3:2')).toBe(true);
		expect(moves.some((item) => item.toCellId === '5:2')).toBe(false);
	});

	it('移動済みの敵はポチャワニを噛めない', () => {
		const state = arena();
		const attacker = place(state, 0, 'katsugi', { x: 3, y: 4 });
		const pocha = place(state, 1, 'pocha', { x: 3, y: 3 });
		attacker.movedThisTurn = true;

		expect(
			legalActionsForPiece(state, attacker.id).some(
				(item) => item.type === 'bite' && item.targetPieceId === pocha.id
			)
		).toBe(false);
	});

	it('トビワニは隣の木を越えて2マス先へ着地する', () => {
		const state = arena();
		const tobi = place(state, 0, 'tobi', { x: 3, y: 4 });
		const hurdle = state.board.cells.find((cell) => cell.id === '3:3');
		if (!hurdle) throw new Error('cell not found');
		hurdle.terrain = 'tree';

		expect(
			legalActionsForPiece(state, tobi.id).some(
				(item) => item.type === 'jump' && item.toCellId === '3:2'
			)
		).toBe(true);
	});

	it('トビワニは1ターンに2回ジャンプできず、占有された着地点へも跳べない', () => {
		const state = arena();
		const tobi = place(state, 0, 'tobi', { x: 3, y: 4 });
		place(state, 0, 'kowa', { x: 3, y: 3 });
		place(state, 0, 'nushi', { x: 3, y: 2 });
		expect(legalActionsForPiece(state, tobi.id).some((item) => item.type === 'jump')).toBe(false);
		state.pieces[pieceId(0, 'nushi')].position = null;
		tobi.jumpedThisTurn = true;
		expect(legalActionsForPiece(state, tobi.id).some((item) => item.type === 'jump')).toBe(false);
	});

	it('コワニは所有者ごとの前へ進み、斜め前だけを噛む', () => {
		const south = arena();
		const southKowa = place(south, 0, 'kowa', { x: 3, y: 4 });
		const southTarget = place(south, 1, 'nushi', { x: 2, y: 3 });
		expect(legalActionsForPiece(south, southKowa.id)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: 'move', toCellId: '3:3' }),
				expect.objectContaining({ type: 'bite', targetPieceId: southTarget.id })
			])
		);

		const north = arena();
		north.activeSeat = 1;
		north.vitality = [0, 2];
		const northKowa = place(north, 1, 'kowa', { x: 3, y: 4 });
		const northTarget = place(north, 0, 'nushi', { x: 4, y: 5 });
		expect(legalActionsForPiece(north, northKowa.id)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: 'move', toCellId: '3:5' }),
				expect.objectContaining({ type: 'bite', targetPieceId: northTarget.id })
			])
		);
	});

	it('ビヨーンワニは空いた中間マス越しに2活力で捕獲する', () => {
		const state = arena();
		const biyoon = place(state, 0, 'biyoon', { x: 3, y: 6 });
		const target = place(state, 1, 'nushi', { x: 3, y: 4 });
		const remote = legalActionsForPiece(state, biyoon.id).find(
			(item) => item.type === 'bite' && item.targetPieceId === target.id && item.remote
		);
		expect(remote).toBeDefined();
		if (!remote) return;

		const result = applyAction(state, remote);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.state.pieces[biyoon.id].position).toEqual({ x: 3, y: 6 });
		expect(result.value.state.pieces[biyoon.id].captiveId).toBe(target.id);
		expect(result.value.state.vitality[0]).toBe(0);
	});

	it('ビヨーンワニの遠距離噛みつきは木・盤外・ワニに遮られる', () => {
		for (const blocker of ['tree', 'void', 'piece'] as const) {
			const state = arena();
			const biyoon = place(state, 0, 'biyoon', { x: 3, y: 6 });
			const target = place(state, 1, 'nushi', { x: 3, y: 4 });
			if (blocker === 'piece') place(state, 0, 'kowa', { x: 3, y: 5 });
			else {
				const middle = state.board.cells.find((cell) => cell.id === '3:5');
				if (!middle) throw new Error('cell not found');
				middle.terrain = blocker;
			}
			expect(
				legalActionsForPiece(state, biyoon.id).some(
					(item) => item.targetPieceId === target.id && item.remote
				),
				blocker
			).toBe(false);
		}
	});

	it('空身なら沼から8方向へ出るか、別の空いている沼へワープできる', () => {
		const state = arena();
		const nushi = place(state, 0, 'nushi', { x: 3, y: 4 });
		const current = state.board.cells.find((cell) => cell.id === '3:4');
		const other = state.board.cells.find((cell) => cell.id === '0:2');
		if (!current || !other) throw new Error('cell not found');
		current.terrain = 'swamp';
		other.terrain = 'swamp';

		const actions = legalActionsForPiece(state, nushi.id);
		expect(actions.filter((item) => item.type === 'move')).toHaveLength(8);
		expect(actions.some((item) => item.type === 'warp' && item.toCellId === other.id)).toBe(true);
	});

	it('占有された沼へはワープできない', () => {
		const state = arena();
		const piece = place(state, 0, 'nushi', { x: 3, y: 4 });
		place(state, 0, 'kowa', { x: 0, y: 2 });
		for (const id of ['3:4', '0:2']) {
			const swamp = state.board.cells.find((cell) => cell.id === id);
			if (!swamp) throw new Error('cell not found');
			swamp.terrain = 'swamp';
		}
		expect(
			legalActionsForPiece(state, piece.id).some(
				(item) => item.type === 'warp' && item.toCellId === '0:2'
			)
		).toBe(false);
	});

	it('沼ワープ後に残り活力で8方向へ退出できる', () => {
		const state = arena();
		const piece = place(state, 0, 'katsugi', { x: 3, y: 4 });
		for (const id of ['3:4', '0:2']) {
			const swamp = state.board.cells.find((cell) => cell.id === id);
			if (!swamp) throw new Error('cell not found');
			swamp.terrain = 'swamp';
		}
		const warp = legalActionsForPiece(state, piece.id).find(
			(item) => item.type === 'warp' && item.toCellId === '0:2'
		);
		if (!warp) throw new Error('warp not found');
		const result = applyAction(state, warp);
		if (!result.ok) throw new Error(result.error);

		expect(result.value.state.vitality[0]).toBe(1);
		expect(
			legalActionsForPiece(result.value.state, piece.id).some(
				(item) => item.type === 'move' && item.toCellId === '1:3'
			)
		).toBe(true);
	});
});

describe('捕獲・救出・捕食', () => {
	it('運搬役を噛むと味方を元のマスへ救出し、敵運搬役を捕虜にする', () => {
		const state = arena();
		const rescuer = place(state, 0, 'nushi', { x: 2, y: 4 });
		const rescued = state.pieces[pieceId(0, 'kowa')];
		rescued.removed = false;
		rescued.capturedBy = pieceId(1, 'katsugi');
		const carrier = place(state, 1, 'katsugi', { x: 3, y: 4 });
		carrier.captiveId = rescued.id;
		const bite = legalActionsForPiece(state, rescuer.id).find(
			(item) => item.targetPieceId === carrier.id
		);
		if (!bite) throw new Error('bite not found');

		const result = applyAction(state, bite);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.state.pieces[rescuer.id].position).toEqual({ x: 3, y: 4 });
		expect(result.value.state.pieces[rescuer.id].captiveId).toBe(carrier.id);
		expect(result.value.state.pieces[rescued.id].position).toEqual({ x: 2, y: 4 });
	});

	it('ビヨーンワニの遠距離救出では味方が敵運搬役のいたマスへ戻る', () => {
		const state = arena();
		const rescuer = place(state, 0, 'biyoon', { x: 3, y: 6 });
		const rescued = state.pieces[pieceId(0, 'kowa')];
		rescued.removed = false;
		rescued.capturedBy = pieceId(1, 'katsugi');
		const carrier = place(state, 1, 'katsugi', { x: 3, y: 4 });
		carrier.captiveId = rescued.id;
		const bite = legalActionsForPiece(state, rescuer.id).find(
			(item) => item.targetPieceId === carrier.id && item.remote
		);
		if (!bite) throw new Error('remote bite not found');

		const result = applyAction(state, bite);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.state.pieces[rescuer.id].position).toEqual({ x: 3, y: 6 });
		expect(result.value.state.pieces[rescued.id].position).toEqual({ x: 3, y: 4 });
	});

	it('救出されたワニは活力が残っていれば同じターンに行動できる', () => {
		const state = arena();
		const rescuer = place(state, 0, 'katsugi', { x: 2, y: 4 });
		const rescued = state.pieces[pieceId(0, 'kowa')];
		rescued.removed = false;
		rescued.capturedBy = pieceId(1, 'katsugi');
		const carrier = place(state, 1, 'katsugi', { x: 3, y: 4 });
		carrier.captiveId = rescued.id;
		const bite = legalActionsForPiece(state, rescuer.id).find(
			(item) => item.targetPieceId === carrier.id
		);
		if (!bite) throw new Error('bite not found');
		const result = applyAction(state, bite);
		if (!result.ok) throw new Error(result.error);

		expect(result.value.state.vitality[0]).toBe(1);
		expect(legalActionsForPiece(result.value.state, rescued.id).length).toBeGreaterThan(0);
	});

	it('カツギワニは1活力で1回だけ運搬できる', () => {
		const state = arena();
		const carrier = place(state, 0, 'katsugi', { x: 3, y: 4 });
		const captive = state.pieces[pieceId(1, 'nushi')];
		captive.removed = false;
		captive.capturedBy = carrier.id;
		carrier.captiveId = captive.id;
		const transport = legalActionsForPiece(state, carrier.id).find(
			(item) => item.type === 'transport' && item.toCellId === cellId({ x: 3, y: 5 })
		);
		if (!transport) throw new Error('transport not found');

		const result = applyAction(state, transport);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.state.vitality[0]).toBe(1);
		expect(
			legalActionsForPiece(result.value.state, carrier.id).some((item) => item.type === 'transport')
		).toBe(false);
	});

	it('通常運搬は2活力で巣へのマンハッタン距離が縮む直交マスだけ', () => {
		const state = arena();
		const carrier = place(state, 0, 'nushi', { x: 3, y: 4 });
		const captive = state.pieces[pieceId(1, 'kowa')];
		captive.removed = false;
		captive.capturedBy = carrier.id;
		carrier.captiveId = captive.id;

		const actions = legalActionsForPiece(state, carrier.id);
		expect(actions).toEqual([
			expect.objectContaining({ type: 'transport', cost: 2, toCellId: '3:5' })
		]);
	});

	it('運搬役は噛みつき・ジャンプ・ワープを実行できない', () => {
		const state = arena();
		const carrier = place(state, 0, 'tobi', { x: 3, y: 4 });
		const captive = state.pieces[pieceId(1, 'kowa')];
		captive.removed = false;
		captive.capturedBy = carrier.id;
		carrier.captiveId = captive.id;
		const current = state.board.cells.find((cell) => cell.id === '3:4');
		const other = state.board.cells.find((cell) => cell.id === '0:2');
		if (!current || !other) throw new Error('cell not found');
		current.terrain = 'swamp';
		other.terrain = 'swamp';

		expect(legalActionsForPiece(state, carrier.id).every((item) => item.type === 'transport')).toBe(
			true
		);
	});

	it('沼にいる運搬役は巣の方向に関係なく1活力で8方向へ1回だけ退出できる', () => {
		const state = arena();
		const carrier = place(state, 0, 'nushi', { x: 3, y: 4 });
		const captive = state.pieces[pieceId(1, 'kowa')];
		captive.removed = false;
		captive.capturedBy = carrier.id;
		carrier.captiveId = captive.id;
		const swamp = state.board.cells.find((cell) => cell.id === '3:4');
		if (!swamp) throw new Error('cell not found');
		swamp.terrain = 'swamp';

		const actions = legalActionsForPiece(state, carrier.id);
		expect(actions).toHaveLength(8);
		expect(actions.every((item) => item.type === 'transport' && item.cost === 1)).toBe(true);
		const away = actions.find((item) => item.toCellId === '3:3');
		if (!away) throw new Error('transport not found');
		const result = applyAction(state, away);
		if (!result.ok) throw new Error(result.error);
		expect(legalActionsForPiece(result.value.state, carrier.id)).toEqual([]);
	});

	it('特殊ワニを巣で捕食すると1Pになり、3Pで勝利する', () => {
		const state = arena();
		state.score[0] = 2;
		const carrier = place(state, 0, 'katsugi', { x: 3, y: 8 });
		const captive = state.pieces[pieceId(1, 'nushi')];
		captive.removed = false;
		captive.capturedBy = carrier.id;
		carrier.captiveId = captive.id;
		const feed = legalActionsForPiece(state, carrier.id).find((item) => item.type === 'feed');
		if (!feed) throw new Error('feed not found');

		const result = applyAction(state, feed);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.state.score[0]).toBe(3);
		expect(result.value.state.winner).toBe(0);
		expect(result.value.state.phase).toBe('finished');
	});

	it('コワニを捕食しても0P', () => {
		const state = arena();
		const carrier = place(state, 0, 'katsugi', { x: 3, y: 8 });
		const captive = state.pieces[pieceId(1, 'kowa')];
		captive.removed = false;
		captive.capturedBy = carrier.id;
		carrier.captiveId = captive.id;
		const feed = legalActionsForPiece(state, carrier.id).find((item) => item.type === 'feed');
		if (!feed) throw new Error('feed not found');

		const result = applyAction(state, feed);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.state.score[0]).toBe(0);
	});

	it('定義は特殊7体が1P、コワニだけ0P', () => {
		expect(CROCODILES.filter((piece) => piece.points === 1)).toHaveLength(7);
		expect(CROCODILES.find((piece) => piece.kind === 'kowa')?.points).toBe(0);
	});

	it('不正または活力不足の行動は入力状態を変更しない', () => {
		const state = arena();
		const before = structuredClone(state);
		const result = applyAction(state, {
			type: 'feed',
			pieceId: pieceId(0, 'nushi'),
			cost: 2,
			label: '不正'
		});
		expect(result.ok).toBe(false);
		expect(state).toEqual(before);
	});

	it('終局後はすべての行動を拒否する', () => {
		const state = arena();
		state.phase = 'finished';
		state.winner = 0;
		state.endReason = 'score';
		expect(allLegalActions(state)).toEqual([]);
		expect(
			applyAction(state, {
				type: 'move',
				pieceId: pieceId(0, 'nushi'),
				toCellId: '3:3',
				cost: 1,
				label: '移動'
			}).ok
		).toBe(false);
	});
});

describe('終局条件', () => {
	it('30ラウンド終了時に得点の高い側を勝者にする', () => {
		const state = readyGame();
		state.round = 30;
		state.score = [1, 2];
		state.positionCounts = {};
		const firstEnd = endTurn(state);
		if (!firstEnd.ok) throw new Error(firstEnd.error);
		const secondEnd = endTurn(firstEnd.value.state);

		expect(secondEnd.ok).toBe(true);
		if (!secondEnd.ok) return;
		expect(secondEnd.value.state.phase).toBe('finished');
		expect(secondEnd.value.state.winner).toBe(1);
		expect(secondEnd.value.state.endReason).toBe('round_limit');
	});

	it('30ラウンド終了時に同点なら引き分けにする', () => {
		const state = readyGame();
		state.round = 30;
		state.positionCounts = {};
		const firstEnd = endTurn(state);
		if (!firstEnd.ok) throw new Error(firstEnd.error);
		const secondEnd = endTurn(firstEnd.value.state);
		if (!secondEnd.ok) throw new Error(secondEnd.error);
		expect(secondEnd.value.state.winner).toBe('draw');
		expect(secondEnd.value.state.endReason).toBe('round_limit');
	});

	it('同一局面が3回現れると引き分けにする', () => {
		let state = readyGame();
		for (let turn = 0; turn < 6 && state.phase === 'playing'; turn += 1) {
			const result = endTurn(state);
			if (!result.ok) throw new Error(result.error);
			state = result.value.state;
		}

		expect(state.phase).toBe('finished');
		expect(state.winner).toBe('draw');
		expect(state.endReason).toBe('repetition');
	});

	it('同じプレイヤーが3ターン連続で時間切れになると敗北する', () => {
		let state = readyGame();
		for (let count = 0; count < 3; count += 1) {
			const timeout = endTurn(state, true);
			if (!timeout.ok) throw new Error(timeout.error);
			state = timeout.value.state;
			if (state.phase === 'finished') break;
			const cpuEnd = endTurn(state);
			if (!cpuEnd.ok) throw new Error(cpuEnd.error);
			state = cpuEnd.value.state;
		}

		expect(state.phase).toBe('finished');
		expect(state.winner).toBe(1);
		expect(state.endReason).toBe('timeout');
	});

	it('自発的なターン終了で連続時間切れ数をリセットする', () => {
		const state = readyGame();
		state.timeoutStreak[0] = 2;
		const result = endTurn(state, false);
		if (!result.ok) throw new Error(result.error);
		expect(result.value.state.timeoutStreak[0]).toBe(0);
	});

	it('合法手に影響するターン内フラグと時間切れ数を同一局面キーに含める', () => {
		const first = readyGame();
		const second = structuredClone(first);
		second.pieces[pieceId(0, 'tobi')].jumpedThisTurn = true;
		expect(normalizedPosition(second)).not.toBe(normalizedPosition(first));
		second.pieces[pieceId(0, 'tobi')].jumpedThisTurn = false;
		second.timeoutStreak[0] = 1;
		expect(normalizedPosition(second)).not.toBe(normalizedPosition(first));
	});

	it('CPU同士の対局が100 seedすべてで規定ターン内に終局する', () => {
		for (let seedIndex = 0; seedIndex < 100; seedIndex += 1) {
			let state = readyGame(`cpu-${seedIndex}`);
			for (let turn = 0; turn < 60 && state.phase === 'playing'; turn += 1) {
				const result = runCpuTurn(state, state.activeSeat);
				if (!result.ok) throw new Error(result.error);
				state = result.value.state;
			}
			expect(state.phase, `cpu-${seedIndex}`).toBe('finished');
			expect(['score', 'round_limit', 'repetition']).toContain(state.endReason);
			expect(allLegalActions(state)).toEqual([]);
		}
	});
});
