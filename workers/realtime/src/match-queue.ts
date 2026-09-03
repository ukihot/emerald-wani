import { DurableObject } from 'cloudflare:workers';

/**
 * MatchQueue — モード×レート帯ごとに1つ割り当てるマッチング待機列の DO。
 * ID は `idFromName("<mode>:<bucket>")`。MVP は bucket を "all" のみとする。
 *
 * 設計は doc/designs/07-durable-objects.md 9.4。要点:
 *   - 1ユーザにつき同時に1エントリのみ（`user_id` を主キーにして構造的に保証する）。
 *   - `requestId` による冪等化で enqueue の再送が二重登録にならないようにする。
 *   - lease 方式: `/status` のたびに `lease_until` を延長し、失効したエントリを alarm が除去する。
 *
 * フェーズ0ではスキーマのみ。ペアリングとマッチ生成はフェーズ4で実装する。
 *
 * 注: このテーブル定義は設計書に SQL が明示されていないため実装側で補ったもの。
 * フェーズ4の実装時に設計書へ反映すること。
 */

/** lease の長さ（ミリ秒）。1秒ポーリング前提だが通信の詰まりに余裕を持たせる。 */
export const LEASE_MS = 20_000;

export class MatchQueue extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			const sql = this.ctx.storage.sql;

			sql.exec(`
				CREATE TABLE IF NOT EXISTS waiting (
					user_id     TEXT PRIMARY KEY,
					request_id  TEXT NOT NULL,
					enqueued_at INTEGER NOT NULL,
					lease_until INTEGER NOT NULL,
					match_id    TEXT
				)
			`);
			sql.exec(`CREATE INDEX IF NOT EXISTS idx_waiting_enqueued ON waiting (enqueued_at)`);
			sql.exec(`CREATE INDEX IF NOT EXISTS idx_waiting_lease ON waiting (lease_until)`);

			// 処理済み requestId を覚えて再送を冪等にする。
			sql.exec(`
				CREATE TABLE IF NOT EXISTS handled_request (
					request_id  TEXT PRIMARY KEY,
					user_id     TEXT NOT NULL,
					handled_at  INTEGER NOT NULL
				)
			`);
		});
	}

	async fetch(): Promise<Response> {
		// TODO(フェーズ4): /enqueue /status /cancel を実装し、alarm(1s) でペアリングする
		// （doc/designs/07-durable-objects.md 9.4 のシーケンス）。
		return new Response('Not Implemented', { status: 501 });
	}
}
