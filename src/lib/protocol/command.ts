import {
	applyAction,
	concede,
	endTurn,
	submitDeployment,
	type DeploymentPlacement,
	type GameResult,
	type GameState,
	type Seat,
	type StateChange
} from '../game/index';
import type { Command, ErrorCode } from './ws';

/**
 * WS の Command をエンジン関数へ振り分ける（旧 match-room.ts 内の同名関数）。
 * ここが実質的な `applyCommand` ディスパッチャである。
 *
 * MatchRoom（実対戦）と過去版リプレイの再生（`replay-compat.spec.ts`）の
 * **両方がこの1本を通る**。再生側に写しを作ると、写しが正しく更新されない限り
 * 「リプレイは再現できるがサーバは壊れている」を検出できなくなる。
 */

export type DispatchResult =
	{ ok: true; value: StateChange } | { ok: false; error: string; errorCode: ErrorCode };

export function dispatchCommand(state: GameState, seat: Seat, command: Command): DispatchResult {
	let result: GameResult<StateChange>;
	switch (command.type) {
		case 'submitDeployment':
			result = submitDeployment(state, seat, command.placements as DeploymentPlacement[]);
			break;
		case 'endTurn':
			result = endTurn(state, false);
			break;
		case 'concede':
			result = concede(state, seat);
			break;
		default:
			// GameAction は `cost`/`label` を持つが、engine.ts の sameAction() 比較には使われない
			// （type/pieceId/toCellId/targetPieceId/remote のみ照合する）。クライアントは cost/label
			// を送らないため、型を満たすためのプレースホルダを補う。
			result = applyAction(state, { ...command, cost: 1, label: '' });
			break;
	}
	if (result.ok) return { ok: true, value: result.value };
	return { ok: false, error: result.error, errorCode: classifyEngineError(command, result.error) };
}

/**
 * エンジンは日本語の自由文でエラーを返す（`GameResult.error: string`）ため、
 * WS プロトコルの安定したエラーコードへ大まかに分類する。完全な一対一対応ではないが、
 * クライアントの分岐に必要な粒度は満たす。
 */
function classifyEngineError(command: Command, message: string): ErrorCode {
	if (command.type === 'submitDeployment') return 'E_DEPLOYMENT_INVALID';
	if (message.includes('活力')) return 'E_INSUFFICIENT_VITALITY';
	if (message.includes('フェーズ') || message.includes('対局中ではありません'))
		return 'E_WRONG_PHASE';
	if (message.includes('手番') || message.includes('実行できません')) return 'E_INVALID_MOVE';
	return 'E_INVALID_TARGET';
}
