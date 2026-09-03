import type { GameState, Seat } from './types';

/**
 * 座席視点への射影。
 *
 * 設計: doc/designs/06-rule-engine.md 6節。
 *   - 布陣中だけ相手の配置が秘匿情報になる。
 *   - 盤面生成後の地形は両者に公開する（射影の対象外）。
 *   - 両者の布陣確定後（`phase !== 'deployment'`）は完全情報として扱う。
 *
 * `GameEvent` は現在の実装（`src/lib/game/engine.ts`）では確定した短い日本語メッセージ
 * のみを保持し、布陣フェーズ中に発行される `deployment`（確定通知のみ）と `reveal`
 * （公開の合図のみ）のどちらも相手の配置内容を含まない。したがって Event 自体の
 * 射影は不要で、射影が必要なのは `GameState`（`MatchView`）だけである。
 */
export type MatchView = GameState;

/**
 * `state` を `seat` から見える形へ射影する。
 * 布陣フェーズ中、相手が所有する駒の `position` を null にする
 * （配置済みかどうかは `deploymentConfirmed` で分かるため、それ以上は開示しない）。
 */
export function projectState(state: GameState, seat: Seat): MatchView {
	if (state.phase !== 'deployment') return state;

	const pieces = { ...state.pieces };
	for (const [id, piece] of Object.entries(pieces)) {
		if (piece.owner !== seat && piece.position !== null) {
			pieces[id] = { ...piece, position: null };
		}
	}
	return { ...state, pieces };
}

/**
 * 射影後の `MatchView` に、相手の秘匿情報が含まれていないことを走査で確認する。
 * テスト専用のプロパティ検証ヘルパー（doc/designs/19-testing.md「射影」層）。
 */
export function findLeakedOpponentPositions(view: MatchView, seat: Seat): string[] {
	if (view.phase !== 'deployment') return [];
	return Object.values(view.pieces)
		.filter((piece) => piece.owner !== seat && piece.position !== null)
		.map((piece) => piece.id);
}
