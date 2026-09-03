import type { GameAction } from './types';

/**
 * クリックされたマスに対応する行動を1つ選ぶ。盤面UIの共通ロジック。
 *
 * 盤面のマスは次のどちらかとして行動に紐づく。
 *
 * - 移動先マス: `move` / `jump` / `warp` / `transport` は `toCellId` を持つ
 * - 対象がいるマス: `bite`（通常・遠距離）は `targetPieceId` を持つ
 *
 * どちらにも該当しないマスは行動を持たない。`feed`（捕食）はその場で実行する
 * 行動なので、特定のマスには紐づけない（コマンドパネルの一覧から実行する）。
 *
 * **注意（過去のバグ）**: `toCellId` と `targetPieceId` はどちらも省略可能なため、
 * 素朴に
 *
 * ```ts
 * candidate.toCellId === targetCellId || candidate.targetPieceId === occupantPieceId
 * ```
 *
 * と書くと、駒のいないマス（`occupantPieceId` が `undefined`）に対して移動系の行動
 * （`targetPieceId` が `undefined`）が `undefined === undefined` で一致してしまう。
 * その結果、空きマス全部が合法手として光り、どのマスを押しても `find()` が返す
 * 先頭の移動（＝北へ1マス）だけが実行される状態になっていた。
 * 比較する前に必ず両辺が存在することを確かめること。
 */
export function actionForCell(
	actions: readonly GameAction[],
	targetCellId: string,
	occupantPieceId?: string
): GameAction | undefined {
	return actions.find((candidate) => {
		if (candidate.toCellId !== undefined) return candidate.toCellId === targetCellId;
		if (candidate.targetPieceId !== undefined) {
			return occupantPieceId !== undefined && candidate.targetPieceId === occupantPieceId;
		}
		return false;
	});
}
