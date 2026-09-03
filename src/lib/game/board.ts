import type { Board, BoardCell, Position, Seat, Zone } from './types';
import { MAP_VERSION } from './versions';

export const BOARD_WIDTH = 7;
export const BOARD_HEIGHT = 9;

const SAFE_CORRIDORS = new Set([1, 5]);

function hashSeed(seed: string): number {
	let hash = 0x811c9dc5;
	for (const char of seed) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

function createRandom(seed: string): () => number {
	let state = hashSeed(seed);
	return () => {
		state += 0x6d2b79f5;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

function shuffle<T>(items: T[], random: () => number): T[] {
	const result = [...items];
	for (let index = result.length - 1; index > 0; index -= 1) {
		const target = Math.floor(random() * (index + 1));
		[result[index], result[target]] = [result[target], result[index]];
	}
	return result;
}

export function cellId(position: Position): string {
	return `${position.x}:${position.y}`;
}

export function parseCellId(id: string): Position | null {
	const match = /^(\d+):(\d+)$/.exec(id);
	if (!match) return null;
	return { x: Number(match[1]), y: Number(match[2]) };
}

export function rotate(position: Position): Position {
	return { x: BOARD_WIDTH - 1 - position.x, y: BOARD_HEIGHT - 1 - position.y };
}

function zoneFor(y: number): Zone {
	if (y <= 1) return 'north';
	if (y >= BOARD_HEIGHT - 2) return 'south';
	return 'neutral';
}

export function homeZone(seat: Seat): Zone {
	return seat === 0 ? 'south' : 'north';
}

export function nestPosition(seat: Seat): Position {
	return seat === 0 ? { x: 3, y: 8 } : { x: 3, y: 0 };
}

function createBaseCells(): BoardCell[] {
	const cells: BoardCell[] = [];
	for (let y = 0; y < BOARD_HEIGHT; y += 1) {
		for (let x = 0; x < BOARD_WIDTH; x += 1) {
			const northNest = x === 3 && y === 0;
			const southNest = x === 3 && y === BOARD_HEIGHT - 1;
			cells.push({
				id: cellId({ x, y }),
				x,
				y,
				zone: zoneFor(y),
				terrain: northNest || southNest ? 'nest' : 'normal',
				...(northNest ? { nestOwner: 1 as Seat } : {}),
				...(southNest ? { nestOwner: 0 as Seat } : {})
			});
		}
	}
	return cells;
}

export function generateBoard(seed: string): Board {
	const representatives: Position[] = [];
	for (let y = 2; y <= 4; y += 1) {
		for (let x = 0; x < BOARD_WIDTH; x += 1) {
			if (SAFE_CORRIDORS.has(x)) continue;
			const position = { x, y };
			const opposite = rotate(position);
			if (position.x === opposite.x && position.y === opposite.y) continue;
			if (cellId(position) > cellId(opposite)) continue;
			representatives.push(position);
		}
	}
	const outlineRepresentatives = representatives.filter(
		(position) => position.x === 0 || position.x === BOARD_WIDTH - 1
	);

	for (let attempt = 0; attempt < 64; attempt += 1) {
		const cells = createBaseCells();
		const attemptSeed =
			attempt === 0 ? `${MAP_VERSION}:${seed}` : `${MAP_VERSION}:${seed}:${attempt}`;
		const outline = shuffle(outlineRepresentatives, createRandom(`${attemptSeed}:outline`))[0];
		const outlineIds = new Set([cellId(outline), cellId(rotate(outline))]);
		const shuffled = shuffle(
			representatives.filter((position) => !outlineIds.has(cellId(position))),
			createRandom(`${attemptSeed}:terrain`)
		);
		const terrainByCell = new Map<string, 'void' | 'tree' | 'swamp'>();
		terrainByCell.set(cellId(outline), 'void');
		terrainByCell.set(cellId(rotate(outline)), 'void');
		for (const [index, position] of shuffled.slice(0, 4).entries()) {
			const terrain = index < 2 ? 'tree' : 'swamp';
			terrainByCell.set(cellId(position), terrain);
			terrainByCell.set(cellId(rotate(position)), terrain);
		}

		for (const cell of cells) {
			const generated = terrainByCell.get(cell.id);
			if (generated && cell.zone === 'neutral') cell.terrain = generated;
		}

		const board = { version: MAP_VERSION, seed, width: BOARD_WIDTH, height: BOARD_HEIGHT, cells };
		if (validateBoard(board).valid) return board;
	}

	throw new Error(`有効な盤面を生成できませんでした: ${seed}`);
}

export function getCell(board: Board, position: Position): BoardCell | undefined {
	return board.cells.find((cell) => cell.x === position.x && cell.y === position.y);
}

export function getCellById(board: Board, id: string): BoardCell | undefined {
	return board.cells.find((cell) => cell.id === id);
}

export function isInside(position: Position): boolean {
	return (
		position.x >= 0 && position.x < BOARD_WIDTH && position.y >= 0 && position.y < BOARD_HEIGHT
	);
}

export function manhattan(a: Position, b: Position): number {
	return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export interface BoardValidation {
	valid: boolean;
	errors: string[];
}

export function validateBoard(board: Board): BoardValidation {
	const errors: string[] = [];
	if (board.width !== BOARD_WIDTH || board.height !== BOARD_HEIGHT)
		errors.push('盤面寸法が不正です');
	if (board.cells.length !== BOARD_WIDTH * BOARD_HEIGHT) errors.push('盤面セル数が不正です');
	if (new Set(board.cells.map((cell) => cell.id)).size !== board.cells.length)
		errors.push('盤面セルIDが重複しています');

	const expectedTerrainCounts = { void: 2, tree: 4, swamp: 4 } as const;
	for (const [terrain, expected] of Object.entries(expectedTerrainCounts)) {
		if (board.cells.filter((cell) => cell.terrain === terrain).length !== expected) {
			errors.push(`${terrain}の生成数が不正です`);
		}
	}

	for (const cell of board.cells) {
		const counterpart = getCell(board, rotate(cell));
		if (!counterpart || counterpart.terrain !== cell.terrain) {
			errors.push(`180度対称ではありません: ${cell.id}`);
			break;
		}
	}

	const passable = board.cells.filter((cell) => cell.terrain !== 'tree' && cell.terrain !== 'void');
	const seen = new Set<string>();
	const first = passable[0];
	if (first) {
		const queue = [first];
		seen.add(first.id);
		while (queue.length > 0) {
			const current = queue.shift();
			if (!current) break;
			for (const [dx, dy] of ORTHOGONAL_DIRECTIONS) {
				const next = getCell(board, { x: current.x + dx, y: current.y + dy });
				if (next && next.terrain !== 'tree' && next.terrain !== 'void' && !seen.has(next.id)) {
					seen.add(next.id);
					queue.push(next);
				}
			}
		}
	}
	if (seen.size !== passable.length) errors.push('通行可能マスが連結していません');

	for (const corridor of SAFE_CORRIDORS) {
		const open = board.cells
			.filter((cell) => cell.x === corridor)
			.every(
				(cell) => cell.terrain !== 'tree' && cell.terrain !== 'swamp' && cell.terrain !== 'void'
			);
		if (!open) errors.push(`通常経路 ${corridor} が塞がれています`);
	}

	for (const seat of [0, 1] as const) {
		const deployable = board.cells.filter(
			(cell) =>
				cell.zone === homeZone(seat) &&
				cell.terrain !== 'nest' &&
				cell.terrain !== 'tree' &&
				cell.terrain !== 'void'
		);
		if (deployable.length < 8) errors.push(`プレイヤー${seat + 1}の配置マスが不足しています`);
		const nest = getCell(board, nestPosition(seat));
		if (nest?.terrain !== 'nest' || nest.nestOwner !== seat) {
			errors.push(`プレイヤー${seat + 1}の巣が不正です`);
		}
	}

	return { valid: errors.length === 0, errors };
}

export const ORTHOGONAL_DIRECTIONS = [
	[0, -1],
	[1, 0],
	[0, 1],
	[-1, 0]
] as const;

export const ALL_DIRECTIONS = [
	...ORTHOGONAL_DIRECTIONS,
	[1, -1],
	[1, 1],
	[-1, 1],
	[-1, -1]
] as const;
