/**
 * 通報の理由コード（doc/designs/11-security-controls.md 11.8.4）。
 *
 * 自由記述は受け取らない。運営が判断するために必要なのは「どの対戦の・どの座席を・
 * どの類型で」であり、自由記述は誹謗の持ち込み口になるため設けない。
 * サーバ・クライアントの双方が同じ列挙を参照できるよう `$lib/protocol` に置く。
 *
 * 画面に出す表示名はここに持たない。Paraglide のカタログ（`messages/{locale}.json` の
 * `report_reason_*`）から `$lib/i18n/match-labels.ts` 経由で引く。
 */
export const REPORT_REASONS = [
	'harassment',
	'cheating',
	'stalling',
	'inappropriate_name',
	'other'
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];
