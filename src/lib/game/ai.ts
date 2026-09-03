import { getCellById, manhattan, nestPosition } from './board';
import {
	allLegalActions,
	applyAction,
	definitionFor,
	endTurn,
	otherSeat,
	pieceAtCell,
	submitDeployment,
	suggestedDeployment
} from './engine';
import type { GameAction, GameEvent, GameResult, GameState, Seat, StateChange } from './types';

function actionScore(state: GameState, candidate: GameAction): number {
	const piece = state.pieces[candidate.pieceId];
	if (candidate.type === 'feed') return 1000;
	if (candidate.type === 'bite' && candidate.targetPieceId) {
		const target = state.pieces[candidate.targetPieceId];
		return 700 + (target.captiveId ? 150 : 0) + definitionFor(target.kind).points * 30;
	}
	if (candidate.type === 'transport' && candidate.toCellId) {
		const destination = getCellById(state.board, candidate.toCellId);
		return destination ? 500 - manhattan(destination, nestPosition(piece.owner)) * 10 : 0;
	}

	if (candidate.toCellId) {
		const destination = getCellById(state.board, candidate.toCellId);
		if (!destination) return 0;
		const enemies = Object.values(state.pieces).filter(
			(enemy) =>
				enemy.owner === otherSeat(piece.owner) &&
				enemy.position &&
				!enemy.removed &&
				enemy.capturedBy === null
		);
		const nearest = Math.min(
			...enemies.map((enemy) => manhattan(destination, enemy.position ?? destination)),
			20
		);
		const occupant = pieceAtCell(state, candidate.toCellId);
		return 200 - nearest * 8 + (occupant ? 0 : 1) + (candidate.type === 'warp' ? -10 : 0);
	}
	return 0;
}

export function chooseCpuAction(state: GameState, seat: Seat = 1): GameAction | null {
	if (state.phase !== 'playing' || state.activeSeat !== seat) return null;
	return (
		allLegalActions(state)
			.map((candidate) => ({ candidate, score: actionScore(state, candidate) }))
			.sort(
				(left, right) =>
					right.score - left.score ||
					left.candidate.pieceId.localeCompare(right.candidate.pieceId) ||
					(left.candidate.toCellId ?? '').localeCompare(right.candidate.toCellId ?? '')
			)[0]?.candidate ?? null
	);
}

export function runCpuTurn(state: GameState, seat: Seat = 1): GameResult<StateChange> {
	if (state.phase !== 'playing' || state.activeSeat !== seat) {
		return { ok: false, error: 'CPUのターンではありません' };
	}
	let current = state;
	const events: GameEvent[] = [];
	for (let step = 0; step < 2 && current.phase === 'playing'; step += 1) {
		const candidate = chooseCpuAction(current, seat);
		if (!candidate) break;
		const result = applyAction(current, candidate);
		if (!result.ok) break;
		current = result.value.state;
		events.push(...result.value.events);
		if (current.vitality[seat] === 0) break;
	}
	if (current.phase === 'finished') return { ok: true, value: { state: current, events } };
	const turnResult = endTurn(current);
	if (!turnResult.ok) return turnResult;
	return {
		ok: true,
		value: { state: turnResult.value.state, events: [...events, ...turnResult.value.events] }
	};
}

export function deployCpu(state: GameState, seat: Seat = 1): GameResult<StateChange> {
	return submitDeployment(state, seat, suggestedDeployment(state, seat));
}
