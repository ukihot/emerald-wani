import { DurableObject } from 'cloudflare:workers';

/**
 * GuestIssuanceGuard — ゲスト発行の「厳密な」1時間あたり上限を強制する DO。
 *
 * Workers の `ratelimit` バインディングは `period` が 10秒 か 60秒 しか取れず、
 * さらにロケーションごとに独立した eventually consistent なカウンタであるため、
 * 「1時間に3回まで」を正確に強制できない（doc/designs/11-security-controls.md 11.4、D-29）。
 * そこで IP ハッシュごとに 1 つの DO を割り当て、内蔵 SQLite にスライディング
 * ウィンドウを保持する。
 *
 * ID は `idFromName(ipHash)`。生 IP は決して渡さない（日次ソルトで HMAC 済みの値を使う）。
 */

/** 窓の長さ（ミリ秒）。 */
const WINDOW_MS = 60 * 60 * 1000;
/** 窓あたりの発行上限。 */
const LIMIT = 3;

export interface GuestIssuanceDecision {
	allowed: boolean;
	/** 窓内に既に記録されている発行数（今回の分を含む）。 */
	count: number;
	/** 拒否された場合に再試行できるまでの秒数。 */
	retryAfterSeconds: number;
}

export class GuestIssuanceGuard extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.sql.exec(
				`CREATE TABLE IF NOT EXISTS issuance (issued_at INTEGER NOT NULL)`
			);
			this.ctx.storage.sql.exec(
				`CREATE INDEX IF NOT EXISTS idx_issuance_at ON issuance (issued_at)`
			);
		});
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// 発行を1件消費して可否を返す。判定と記録を1呼び出しで行うことで、
		// 同時リクエストによるすり抜けを防ぐ（DO 内は直列実行）。
		if (request.method === 'POST' && url.pathname === '/consume') {
			return Response.json(this.consume(Date.now()));
		}

		// 記録せずに現在の状態だけを見る（監視・デバッグ用）。
		if (request.method === 'GET' && url.pathname === '/peek') {
			return Response.json(this.peek(Date.now()));
		}

		return new Response('Not Found', { status: 404 });
	}

	/**
	 * 窓内の発行数を数え、上限未満なら記録して allowed を返す。
	 * SQLite の同期 API のみを使い、途中に `await` を挟まないことで原子性を保つ。
	 */
	private consume(now: number): GuestIssuanceDecision {
		const state = this.peek(now);
		if (!state.allowed) return state;

		this.ctx.storage.sql.exec(`INSERT INTO issuance (issued_at) VALUES (?)`, now);
		return { allowed: true, count: state.count + 1, retryAfterSeconds: 0 };
	}

	private peek(now: number): GuestIssuanceDecision {
		const windowStart = now - WINDOW_MS;

		// 窓から外れた記録は保持しない（この DO に個人追跡の材料を残さないため）。
		this.ctx.storage.sql.exec(`DELETE FROM issuance WHERE issued_at < ?`, windowStart);

		const rows = this.ctx.storage.sql
			.exec<{ issued_at: number }>(`SELECT issued_at FROM issuance ORDER BY issued_at ASC`)
			.toArray();

		if (rows.length < LIMIT) {
			return { allowed: true, count: rows.length, retryAfterSeconds: 0 };
		}

		// 最も古い記録が窓から外れれば1枠空く。
		const oldest = rows[0].issued_at;
		const retryAfterMs = Math.max(0, oldest + WINDOW_MS - now);
		return {
			allowed: false,
			count: rows.length,
			retryAfterSeconds: Math.ceil(retryAfterMs / 1000)
		};
	}
}
