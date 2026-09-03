import {
	ALL_DIRECTIONS,
	ORTHOGONAL_DIRECTIONS,
	cellId,
	generateBoard,
	getCell,
	getCellById,
	homeZone,
	isInside,
	manhattan,
	nestPosition
} from './board';
import type {
	ActionType,
	Crocodile,
	CrocodileDefinition,
	CrocodileKind,
	DeploymentPlacement,
	GameAction,
	GameEvent,
	GameResult,
	GameState,
	Position,
	Seat,
	StateChange
} from './types';
import { RULE_VERSION } from './versions';

export const CROCODILES: readonly CrocodileDefinition[] = [
	{
		kind: 'nushi',
		name: 'ヌシワニ',
		shortName: '主',
		points: 1,
		description: '周囲8方向へ1マス移動・噛みつき'
	},
	{
		kind: 'katsugi',
		name: 'カツギワニ',
		shortName: '担',
		points: 1,
		description: '捕虜を1活力で運搬'
	},
	{
		kind: 'pocha',
		name: 'ポチャワニ',
		shortName: 'ぽ',
		points: 1,
		description: '移動済みの敵から噛まれない'
	},
	{
		kind: 'biyoon',
		name: 'ビヨーンワニ',
		shortName: '伸',
		points: 1,
		description: '直線2マス先を遠距離捕獲'
	},
	{
		kind: 'naname',
		name: 'ナナメワニ',
		shortName: '斜',
		points: 1,
		description: '斜めへ最大2マス移動'
	},
	{
		kind: 'sekkachi',
		name: 'セッカチワニ',
		shortName: '急',
		points: 1,
		description: '直線を最大2マス移動、移動後は噛めない'
	},
	{
		kind: 'tobi',
		name: 'トビワニ',
		shortName: '跳',
		points: 1,
		description: '隣のワニまたは木を飛び越える'
	},
	{
		kind: 'kowa',
		name: 'コワニ',
		shortName: '子',
		points: 0,
		description: '前へ移動、斜め前を噛む・0P'
	}
] as const;

const definitionByKind = new Map(CROCODILES.map((definition) => [definition.kind, definition]));

export function definitionFor(kind: CrocodileKind): CrocodileDefinition {
	const definition = definitionByKind.get(kind);
	if (!definition) throw new Error(`Unknown crocodile kind: ${kind}`);
	return definition;
}

export function otherSeat(seat: Seat): Seat {
	return seat === 0 ? 1 : 0;
}

export function pieceId(seat: Seat, kind: CrocodileKind): string {
	return `${seat}:${kind}`;
}

function createPieces(): Record<string, Crocodile> {
	const pieces: Record<string, Crocodile> = {};
	for (const seat of [0, 1] as const) {
		for (const definition of CROCODILES) {
			const id = pieceId(seat, definition.kind);
			pieces[id] = {
				id,
				kind: definition.kind,
				owner: seat,
				position: null,
				captiveId: null,
				capturedBy: null,
				removed: false,
				movedThisTurn: false,
				transportedThisTurn: false,
				jumpedThisTurn: false
			};
		}
	}
	return pieces;
}

export function createGame(seed = 'EMERALD-001'): GameState {
	const board = generateBoard(seed);
	const firstSeat = 0 as const;
	return {
		ruleVersion: RULE_VERSION,
		mapVersion: board.version,
		board,
		phase: 'deployment',
		pieces: createPieces(),
		deploymentConfirmed: [false, false],
		firstSeat,
		activeSeat: firstSeat,
		round: 1,
		turnNumber: 1,
		vitality: [0, 0],
		score: [0, 0],
		timeoutStreak: [0, 0],
		winner: null,
		endReason: null,
		positionCounts: {}
	};
}

function cloneState(state: GameState): GameState {
	return {
		...state,
		board: {
			...state.board,
			cells: state.board.cells.map((cell) => ({ ...cell }))
		},
		pieces: Object.fromEntries(
			Object.entries(state.pieces).map(([id, piece]) => [
				id,
				{ ...piece, position: piece.position ? { ...piece.position } : null }
			])
		),
		deploymentConfirmed: [...state.deploymentConfirmed],
		vitality: [...state.vitality],
		score: [...state.score],
		timeoutStreak: [...state.timeoutStreak],
		positionCounts: { ...state.positionCounts }
	};
}

export function pieceAt(state: GameState, position: Position): Crocodile | undefined {
	return Object.values(state.pieces).find(
		(piece) =>
			!piece.removed &&
			piece.capturedBy === null &&
			piece.position?.x === position.x &&
			piece.position.y === position.y
	);
}

export function pieceAtCell(state: GameState, targetCellId: string): Crocodile | undefined {
	const cell = getCellById(state.board, targetCellId);
	return cell ? pieceAt(state, cell) : undefined;
}

function isOpen(state: GameState, position: Position): boolean {
	const cell = getCell(state.board, position);
	return Boolean(
		cell && cell.terrain !== 'tree' && cell.terrain !== 'void' && !pieceAt(state, position)
	);
}

function add(position: Position, direction: readonly [number, number], distance = 1): Position {
	return { x: position.x + direction[0] * distance, y: position.y + direction[1] * distance };
}

function action(
	type: ActionType,
	piece: Crocodile,
	cost: 1 | 2,
	label: string,
	extra: Partial<GameAction> = {}
): GameAction {
	return { type, pieceId: piece.id, cost, label, ...extra };
}

export function submitDeployment(
	state: GameState,
	seat: Seat,
	placements: DeploymentPlacement[]
): GameResult<StateChange> {
	if (state.phase !== 'deployment') return { ok: false, error: '布陣フェーズではありません' };
	if (state.deploymentConfirmed[seat]) return { ok: false, error: '布陣は確定済みです' };
	if (placements.length !== CROCODILES.length) {
		return { ok: false, error: '8体すべてを配置してください' };
	}

	const kinds = new Set<CrocodileKind>();
	const cells = new Set<string>();
	for (const placement of placements) {
		if (kinds.has(placement.kind)) return { ok: false, error: '同じワニを重複配置できません' };
		if (cells.has(placement.cellId)) return { ok: false, error: '同じマスへ重複配置できません' };
		const cell = getCellById(state.board, placement.cellId);
		if (
			!cell ||
			cell.zone !== homeZone(seat) ||
			cell.terrain === 'tree' ||
			cell.terrain === 'void' ||
			cell.terrain === 'nest'
		) {
			return { ok: false, error: '味方ゾーンの通常マスへ配置してください' };
		}
		if (pieceAtCell(state, placement.cellId)) return { ok: false, error: '使用中のマスです' };
		kinds.add(placement.kind);
		cells.add(placement.cellId);
	}

	const next = cloneState(state);
	for (const placement of placements) {
		const cell = getCellById(next.board, placement.cellId);
		if (!cell) return { ok: false, error: '配置マスが見つかりません' };
		next.pieces[pieceId(seat, placement.kind)].position = { x: cell.x, y: cell.y };
	}
	next.deploymentConfirmed[seat] = true;
	const events: GameEvent[] = [
		{ type: 'deployment', message: `プレイヤー${seat + 1}が布陣を確定` }
	];

	if (next.deploymentConfirmed[0] && next.deploymentConfirmed[1]) {
		next.phase = 'playing';
		next.activeSeat = next.firstSeat;
		next.vitality[next.activeSeat] = 1;
		events.push({ type: 'reveal', message: '両軍の布陣を公開。対局開始！' });
		recordPosition(next);
	}
	return { ok: true, value: { state: next, events } };
}

export function deploymentCellOrder(state: GameState, seat: Seat): string[] {
	const rows = seat === 0 ? [7, 8] : [1, 0];
	const centerOut = [3, 2, 4, 1, 5, 0, 6];
	return rows
		.flatMap((y) => centerOut.map((x) => getCell(state.board, { x, y })))
		.filter((cell): cell is NonNullable<typeof cell> => Boolean(cell))
		.filter((cell) => cell.terrain !== 'nest' && cell.terrain !== 'tree')
		.filter((cell) => cell.terrain !== 'void')
		.map((cell) => cell.id);
}

export function suggestedDeployment(state: GameState, seat: Seat): DeploymentPlacement[] {
	const cells = deploymentCellOrder(state, seat);
	return CROCODILES.map((definition, index) => ({
		kind: definition.kind,
		cellId: cells[index]
	}));
}

export function completeDeployment(
	state: GameState,
	seat: Seat,
	placements: DeploymentPlacement[]
): DeploymentPlacement[] {
	const allowedCells = new Set(deploymentCellOrder(state, seat));
	const usedKinds = new Set<CrocodileKind>();
	const usedCells = new Set<string>();
	const completed: DeploymentPlacement[] = [];
	for (const placement of placements) {
		if (
			usedKinds.has(placement.kind) ||
			usedCells.has(placement.cellId) ||
			!allowedCells.has(placement.cellId)
		) {
			continue;
		}
		usedKinds.add(placement.kind);
		usedCells.add(placement.cellId);
		completed.push(placement);
	}

	const freeCells = deploymentCellOrder(state, seat).filter((id) => !usedCells.has(id));
	for (const definition of CROCODILES) {
		if (usedKinds.has(definition.kind)) continue;
		const cellId = freeCells.shift();
		if (!cellId) throw new Error('自動配置に必要なマスが不足しています');
		completed.push({ kind: definition.kind, cellId });
	}
	return completed;
}

function movementDirections(piece: Crocodile): readonly (readonly [number, number])[] {
	if (piece.kind === 'nushi') return ALL_DIRECTIONS;
	if (piece.kind === 'naname')
		return [
			[1, -1],
			[1, 1],
			[-1, 1],
			[-1, -1]
		];
	if (piece.kind === 'kowa') return [[0, piece.owner === 0 ? -1 : 1]];
	return ORTHOGONAL_DIRECTIONS;
}

function biteDirections(piece: Crocodile): readonly (readonly [number, number])[] {
	if (piece.kind === 'nushi') return ALL_DIRECTIONS;
	if (piece.kind === 'naname')
		return [
			[1, -1],
			[1, 1],
			[-1, 1],
			[-1, -1]
		];
	if (piece.kind === 'kowa') {
		const forward = piece.owner === 0 ? -1 : 1;
		return [
			[1, forward],
			[-1, forward]
		];
	}
	return ORTHOGONAL_DIRECTIONS;
}

function canBite(attacker: Crocodile, target: Crocodile): boolean {
	if (target.owner === attacker.owner || target.removed || target.capturedBy !== null) return false;
	if (attacker.kind === 'sekkachi' && attacker.movedThisTurn) return false;
	if (target.kind === 'pocha' && attacker.movedThisTurn) return false;
	return true;
}

function movementActions(state: GameState, piece: Crocodile): GameAction[] {
	if (!piece.position) return [];
	const currentCell = getCell(state.board, piece.position);
	if (!currentCell) return [];
	const actions: GameAction[] = [];

	if (currentCell.terrain === 'swamp') {
		for (const direction of ALL_DIRECTIONS) {
			const destination = add(piece.position, direction);
			if (isOpen(state, destination)) {
				actions.push(action('move', piece, 1, '沼から出る', { toCellId: cellId(destination) }));
			}
		}
		for (const swamp of state.board.cells) {
			if (swamp.terrain === 'swamp' && swamp.id !== currentCell.id && isOpen(state, swamp)) {
				actions.push(action('warp', piece, 1, '沼ワープ', { toCellId: swamp.id }));
			}
		}
		return actions;
	}

	const maxDistance = piece.kind === 'naname' || piece.kind === 'sekkachi' ? 2 : 1;
	for (const direction of movementDirections(piece)) {
		for (let distance = 1; distance <= maxDistance; distance += 1) {
			const destination = add(piece.position, direction, distance);
			if (!isInside(destination)) break;
			if (!isOpen(state, destination)) break;
			actions.push(action('move', piece, 1, '移動', { toCellId: cellId(destination) }));
		}
	}

	if (piece.kind === 'tobi' && !piece.jumpedThisTurn) {
		for (const direction of ALL_DIRECTIONS) {
			const hurdle = add(piece.position, direction);
			const destination = add(piece.position, direction, 2);
			const hurdleCell = getCell(state.board, hurdle);
			const hasHurdle = hurdleCell?.terrain === 'tree' || Boolean(pieceAt(state, hurdle));
			if (hasHurdle && isOpen(state, destination)) {
				actions.push(action('jump', piece, 1, 'ジャンプ', { toCellId: cellId(destination) }));
			}
		}
	}
	return actions;
}

function biteActions(state: GameState, piece: Crocodile): GameAction[] {
	if (!piece.position || piece.captiveId) return [];
	const actions: GameAction[] = [];
	for (const direction of biteDirections(piece)) {
		const target = pieceAt(state, add(piece.position, direction));
		if (target && canBite(piece, target)) {
			actions.push(
				action('bite', piece, 1, target.captiveId ? '噛みついて救出' : '噛みつき', {
					targetPieceId: target.id
				})
			);
		}
	}

	if (piece.kind === 'biyoon') {
		for (const direction of ORTHOGONAL_DIRECTIONS) {
			const middle = add(piece.position, direction);
			const targetPosition = add(piece.position, direction, 2);
			const middleCell = getCell(state.board, middle);
			const target = pieceAt(state, targetPosition);
			if (
				middleCell &&
				middleCell.terrain !== 'tree' &&
				middleCell.terrain !== 'void' &&
				!pieceAt(state, middle) &&
				target &&
				canBite(piece, target)
			) {
				actions.push(
					action('bite', piece, 2, target.captiveId ? '遠距離救出' : '遠距離噛みつき', {
						targetPieceId: target.id,
						remote: true
					})
				);
			}
		}
	}
	return actions;
}

function carrierActions(state: GameState, piece: Crocodile): GameAction[] {
	if (!piece.position || !piece.captiveId) return [];
	const actions: GameAction[] = [];
	const currentCell = getCell(state.board, piece.position);
	const home = nestPosition(piece.owner);
	if (currentCell?.terrain === 'nest' && currentCell.nestOwner === piece.owner) {
		actions.push(action('feed', piece, 2, '捕食'));
	}
	if (piece.transportedThisTurn) return actions;

	const cost = piece.kind === 'katsugi' ? 1 : 2;
	const directions = currentCell?.terrain === 'swamp' ? ALL_DIRECTIONS : ORTHOGONAL_DIRECTIONS;
	for (const direction of directions) {
		const destination = add(piece.position, direction);
		if (!isOpen(state, destination)) continue;
		if (
			currentCell?.terrain !== 'swamp' &&
			manhattan(destination, home) >= manhattan(piece.position, home)
		) {
			continue;
		}
		actions.push(
			action('transport', piece, currentCell?.terrain === 'swamp' ? 1 : cost, '捕虜を運搬', {
				toCellId: cellId(destination)
			})
		);
	}
	return actions;
}

export function legalActionsForPiece(state: GameState, targetPieceId: string): GameAction[] {
	if (state.phase !== 'playing') return [];
	const piece = state.pieces[targetPieceId];
	if (
		!piece ||
		piece.owner !== state.activeSeat ||
		piece.removed ||
		piece.capturedBy !== null ||
		!piece.position
	) {
		return [];
	}
	const actions = piece.captiveId
		? carrierActions(state, piece)
		: [...movementActions(state, piece), ...biteActions(state, piece)];
	return actions.filter((candidate) => candidate.cost <= state.vitality[state.activeSeat]);
}

export function allLegalActions(state: GameState): GameAction[] {
	return Object.values(state.pieces).flatMap((piece) => legalActionsForPiece(state, piece.id));
}

function sameAction(left: GameAction, right: GameAction): boolean {
	return (
		left.type === right.type &&
		left.pieceId === right.pieceId &&
		left.toCellId === right.toCellId &&
		left.targetPieceId === right.targetPieceId &&
		Boolean(left.remote) === Boolean(right.remote)
	);
}

function movePiece(piece: Crocodile, position: Position): void {
	piece.position = { ...position };
	piece.movedThisTurn = true;
}

function capture(
	state: GameState,
	attacker: Crocodile,
	target: Crocodile,
	remote: boolean,
	events: GameEvent[]
): void {
	if (!attacker.position || !target.position) return;
	const attackerOrigin = { ...attacker.position };
	const targetOrigin = { ...target.position };
	const rescuedId = target.captiveId;

	if (!remote) movePiece(attacker, targetOrigin);
	attacker.captiveId = target.id;
	target.position = null;
	target.capturedBy = attacker.id;
	target.captiveId = null;

	const attackerName = definitionFor(attacker.kind).name;
	const targetName = definitionFor(target.kind).name;
	events.push({
		type: 'capture',
		message: `${attackerName}が${targetName}を${remote ? '遠距離で' : ''}捕獲`
	});

	if (rescuedId) {
		const rescued = state.pieces[rescuedId];
		rescued.capturedBy = null;
		rescued.position = remote ? targetOrigin : attackerOrigin;
		events.push({
			type: 'rescue',
			message: `${definitionFor(rescued.kind).name}を救出`
		});
	}
}

export function applyAction(state: GameState, requested: GameAction): GameResult<StateChange> {
	if (state.phase !== 'playing') return { ok: false, error: '対局中ではありません' };
	const legal = legalActionsForPiece(state, requested.pieceId).find((candidate) =>
		sameAction(candidate, requested)
	);
	if (!legal) return { ok: false, error: '現在はその行動を実行できません' };

	const next = cloneState(state);
	const piece = next.pieces[legal.pieceId];
	next.vitality[next.activeSeat] -= legal.cost;
	const events: GameEvent[] = [];

	if (legal.type === 'move' || legal.type === 'jump' || legal.type === 'warp') {
		const destination = legal.toCellId ? getCellById(next.board, legal.toCellId) : undefined;
		if (!destination) return { ok: false, error: '移動先が見つかりません' };
		movePiece(piece, destination);
		if (legal.type === 'jump') piece.jumpedThisTurn = true;
		events.push({
			type: legal.type,
			message: `${definitionFor(piece.kind).name}：${legal.label}`
		});
	}

	if (legal.type === 'transport') {
		const destination = legal.toCellId ? getCellById(next.board, legal.toCellId) : undefined;
		if (!destination) return { ok: false, error: '運搬先が見つかりません' };
		movePiece(piece, destination);
		piece.transportedThisTurn = true;
		events.push({
			type: 'transport',
			message: `${definitionFor(piece.kind).name}が捕虜を運搬`
		});
	}

	if (legal.type === 'bite' && legal.targetPieceId) {
		capture(next, piece, next.pieces[legal.targetPieceId], Boolean(legal.remote), events);
	}

	if (legal.type === 'feed' && piece.captiveId) {
		const captive = next.pieces[piece.captiveId];
		const points = definitionFor(captive.kind).points;
		captive.removed = true;
		captive.capturedBy = null;
		piece.captiveId = null;
		next.score[piece.owner] += points;
		events.push({
			type: 'feed',
			message: `${definitionFor(piece.kind).name}が${definitionFor(captive.kind).name}を捕食（${points}P）`
		});
	}

	checkScoreWin(next, events);
	if (next.phase === 'playing') recordPosition(next, events);
	return { ok: true, value: { state: next, events } };
}

function resetTurnFlags(state: GameState, seat: Seat): void {
	for (const piece of Object.values(state.pieces)) {
		if (piece.owner === seat) {
			piece.movedThisTurn = false;
			piece.transportedThisTurn = false;
			piece.jumpedThisTurn = false;
		}
	}
}

function finish(
	state: GameState,
	winner: Seat | 'draw',
	reason: GameState['endReason'],
	message: string,
	events: GameEvent[]
): void {
	state.phase = 'finished';
	state.winner = winner;
	state.endReason = reason;
	events.push({ type: 'finish', message });
}

function checkScoreWin(state: GameState, events: GameEvent[]): void {
	for (const seat of [0, 1] as const) {
		if (state.score[seat] >= 3) {
			finish(state, seat, 'score', `プレイヤー${seat + 1}が3Pを獲得して勝利！`, events);
			return;
		}
	}
}

export function normalizedPosition(state: GameState): string {
	const pieces = Object.values(state.pieces)
		.map((piece) => ({
			id: piece.id,
			position: piece.position ? cellId(piece.position) : null,
			captiveId: piece.captiveId,
			capturedBy: piece.capturedBy,
			removed: piece.removed,
			movedThisTurn: piece.movedThisTurn,
			transportedThisTurn: piece.transportedThisTurn,
			jumpedThisTurn: piece.jumpedThisTurn
		}))
		.sort((left, right) => left.id.localeCompare(right.id));
	return JSON.stringify({
		activeSeat: state.activeSeat,
		vitality: state.vitality,
		score: state.score,
		timeoutStreak: state.timeoutStreak,
		pieces
	});
}

function recordPosition(state: GameState, events: GameEvent[] = []): void {
	const key = normalizedPosition(state);
	state.positionCounts[key] = (state.positionCounts[key] ?? 0) + 1;
	if (state.positionCounts[key] >= 3 && state.phase === 'playing') {
		finish(state, 'draw', 'repetition', '同一局面が3回現れたため引き分け', events);
	}
}

function adjudicateRoundLimit(state: GameState, events: GameEvent[]): void {
	if (state.score[0] === state.score[1]) {
		finish(state, 'draw', 'round_limit', '30ラウンド終了。同点のため引き分け', events);
		return;
	}
	const winner: Seat = state.score[0] > state.score[1] ? 0 : 1;
	finish(state, winner, 'round_limit', `30ラウンド終了。プレイヤー${winner + 1}の勝利`, events);
}

export function endTurn(state: GameState, timedOut = false): GameResult<StateChange> {
	if (state.phase !== 'playing') return { ok: false, error: '対局中ではありません' };
	const next = cloneState(state);
	const endingSeat = next.activeSeat;
	const events: GameEvent[] = [];
	next.vitality[endingSeat] = 0;
	if (timedOut) {
		next.timeoutStreak[endingSeat] += 1;
		events.push({ type: 'turn', message: `プレイヤー${endingSeat + 1}が時間切れ` });
		if (next.timeoutStreak[endingSeat] >= 3) {
			finish(
				next,
				otherSeat(endingSeat),
				'timeout',
				`プレイヤー${endingSeat + 1}が3ターン連続で時間切れ`,
				events
			);
			return { ok: true, value: { state: next, events } };
		}
	} else {
		next.timeoutStreak[endingSeat] = 0;
	}

	const incomingSeat = otherSeat(endingSeat);
	if (incomingSeat === next.firstSeat) {
		if (next.round >= 30) {
			adjudicateRoundLimit(next, events);
			return { ok: true, value: { state: next, events } };
		}
		next.round += 1;
	}

	next.activeSeat = incomingSeat;
	next.turnNumber += 1;
	next.vitality[incomingSeat] = 2;
	resetTurnFlags(next, incomingSeat);
	events.push({
		type: 'turn',
		message: `ラウンド${next.round}・プレイヤー${incomingSeat + 1}のターン`
	});
	recordPosition(next, events);
	return { ok: true, value: { state: next, events } };
}

export function concede(state: GameState, seat: Seat): GameResult<StateChange> {
	if (state.phase !== 'playing') return { ok: false, error: '対局中ではありません' };
	const next = cloneState(state);
	const events: GameEvent[] = [];
	finish(next, otherSeat(seat), 'concede', `プレイヤー${seat + 1}が投了`, events);
	return { ok: true, value: { state: next, events } };
}
