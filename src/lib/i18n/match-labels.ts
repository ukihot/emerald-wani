import { m } from '$lib/paraglide/messages';
import { getLocale } from '$lib/paraglide/runtime';
import type { ReportReason } from '$lib/protocol/report';
import type { Terrain } from '$lib/game/types';

/**
 * 画面に出す文言は、すべて Paraglide のメッセージカタログ（`messages/{locale}.json`）
 * から引く。ここは「コード値 → メッセージ関数」の対応だけを持つ橋渡しで、
 * 文字リテラルを画面側に散らかさないための一箇所である。
 *
 * 対象外（意図的にカタログへ移していないもの）:
 *   - ルールエンジンが返す `GameEvent.message` とワニの定義名（`definitionFor`）。
 *     これらは `rules-1.0.0` に紐づく**版数付きのデータ**で、リプレイ（R2）と
 *     `event_log` に永続化される。翻訳するとリプレイの再生結果が locale で変わって
 *     しまうため、UI 文字列ではなくデータとして扱う
 *     （doc/designs/06-rule-engine.md、doc/designs/09-api-protocol.md 4節）。
 *   - REST の `{ error: { code, message } }`。安定したコードと対で返すプロトコル値。
 */

/** `match_player.result` の値。 */
export function resultLabel(result: string): string {
	if (result === 'win') return m.result_win();
	if (result === 'loss') return m.result_loss();
	return m.result_draw();
}

/** `match.end_reason`（ルールエンジンの `EndReason`）。 */
export function endReasonLabel(endReason: string | null): string {
	switch (endReason) {
		case 'score':
			return m.end_reason_score();
		case 'round_limit':
			return m.end_reason_round_limit();
		case 'repetition':
			return m.end_reason_repetition();
		case 'concede':
			return m.end_reason_concede();
		case 'timeout':
			return m.end_reason_timeout();
		default:
			return m.end_reason_unknown();
	}
}

export function terrainLabel(terrain: Terrain): string {
	switch (terrain) {
		case 'swamp':
			return m.terrain_swamp();
		case 'tree':
			return m.terrain_tree();
		case 'nest':
			return m.terrain_nest();
		case 'void':
			return m.terrain_void();
		default:
			return m.terrain_normal();
	}
}

export function reportReasonLabel(reason: ReportReason): string {
	switch (reason) {
		case 'harassment':
			return m.report_reason_harassment();
		case 'cheating':
			return m.report_reason_cheating();
		case 'stalling':
			return m.report_reason_stalling();
		case 'inappropriate_name':
			return m.report_reason_inappropriate_name();
		default:
			return m.report_reason_other();
	}
}

/** 日時表示。表示形式も locale に従わせる（固定の 'ja-JP' を書かない）。 */
export function formatDateTime(value: number | null): string {
	if (!value) return m.history_in_progress();
	return new Date(value).toLocaleString(getLocale(), {
		dateStyle: 'short',
		timeStyle: 'short'
	});
}

export function formatDateTimeLong(value: number | null): string {
	if (!value) return m.end_reason_unknown();
	return new Date(value).toLocaleString(getLocale(), {
		dateStyle: 'medium',
		timeStyle: 'short'
	});
}
