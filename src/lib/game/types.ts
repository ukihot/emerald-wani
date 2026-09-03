export type Seat = 0 | 1;

export type CrocodileKind =
	'nushi' | 'katsugi' | 'pocha' | 'biyoon' | 'naname' | 'sekkachi' | 'tobi' | 'kowa';

export type Terrain = 'normal' | 'swamp' | 'tree' | 'nest' | 'void';
export type Zone = 'north' | 'neutral' | 'south';
export type Phase = 'deployment' | 'playing' | 'finished';

export interface Position {
	x: number;
	y: number;
}

export interface BoardCell extends Position {
	id: string;
	terrain: Terrain;
	zone: Zone;
	nestOwner?: Seat;
}

export interface Board {
	version: string;
	seed: string;
	width: number;
	height: number;
	cells: BoardCell[];
}

export interface CrocodileDefinition {
	kind: CrocodileKind;
	name: string;
	shortName: string;
	points: 0 | 1;
	description: string;
}

export interface Crocodile {
	id: string;
	kind: CrocodileKind;
	owner: Seat;
	position: Position | null;
	captiveId: string | null;
	capturedBy: string | null;
	removed: boolean;
	movedThisTurn: boolean;
	transportedThisTurn: boolean;
	jumpedThisTurn: boolean;
}

export interface DeploymentPlacement {
	kind: CrocodileKind;
	cellId: string;
}

export type ActionType = 'move' | 'bite' | 'jump' | 'warp' | 'transport' | 'feed';

export interface GameAction {
	type: ActionType;
	pieceId: string;
	cost: 1 | 2;
	toCellId?: string;
	targetPieceId?: string;
	remote?: boolean;
	label: string;
}

export interface GameEvent {
	type:
		| 'deployment'
		| 'reveal'
		| 'move'
		| 'jump'
		| 'warp'
		| 'capture'
		| 'rescue'
		| 'transport'
		| 'feed'
		| 'turn'
		| 'finish';
	message: string;
}

export type EndReason = 'score' | 'round_limit' | 'repetition' | 'concede' | 'timeout';

export interface GameState {
	ruleVersion: string;
	mapVersion: string;
	board: Board;
	phase: Phase;
	pieces: Record<string, Crocodile>;
	deploymentConfirmed: [boolean, boolean];
	firstSeat: Seat;
	activeSeat: Seat;
	round: number;
	turnNumber: number;
	vitality: [number, number];
	score: [number, number];
	timeoutStreak: [number, number];
	winner: Seat | 'draw' | null;
	endReason: EndReason | null;
	positionCounts: Record<string, number>;
}

export type GameResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface StateChange {
	state: GameState;
	events: GameEvent[];
}
