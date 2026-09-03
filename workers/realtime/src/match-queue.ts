import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import { MAP_VERSION, RULE_VERSION } from '$game/versions';

/**
 * MatchQueue — モード×レート帯ごとに1つ割り当てるマッチング待機列の DO。
 * ID は `idFromName("<mode>:<bucket>")`。MVP は bucket を "all" のみとする。
 *
 * 設計は doc/designs/07-durable-objects.md 9.4。要点:
 *   - 1ユーザにつき同時に1エントリのみ（`user_id` を主キーにして構造的に保証する）。
 *   - `requestId` による冪等化で enqueue の再送が二重登録にならないようにする。
 *   - lease 方式: `/status` のたびに `lease_until` を延長し、失効したエントリを alarm が除去する。
 *
 * このワーカー内の DO は realtime Worker の default fetch からは到達しない
 * （doc/designs/02-architecture.md 3.3）。web Worker が `platform.env.MATCH_QUEUE`
 * バインディング経由でのみ呼び出す。呼び出し元がセッションで userId を検証済みである
 * ことを前提にした内部専用インタフェースであり、REST 層の認可はここでは再検証しない。
 *
 * 既知の制約（フェーズ5で解消）: 「1ユーザが同時に進行中の試合を複数持てない」制約は
 * MatchRoom `/internal/init` 側では検証できない（D1 に対戦の一覧が無いため）。
 * 現状はマッチング経路（MatchQueue の1エントリ制約）だけがこれを事実上保証している。
 */

/** lease の長さ（ミリ秒）。1秒ポーリング前提だが通信の詰まりに余裕を持たせる。 */
export const LEASE_MS = 20_000;

/** ペアリング後、`/status` が matched を返せるようにエントリを残しておく時間。 */
const MATCHED_RETENTION_MS = 30_000;

/** 待機列が空でなくなったときの再スケジュール間隔。 */
const PAIRING_INTERVAL_MS = 1_000;

const EnqueueBodySchema = v.strictObject({
	userId: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
	requestId: v.pipe(v.string(), v.minLength(1), v.maxLength(64))
});

interface WaitingRow extends Record<string, SqlStorageValue> {
	user_id: string;
	request_id: string;
	enqueued_at: number;
	lease_until: number;
	match_id: string | null;
	matched_at: number | null;
}

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
					match_id    TEXT,
					matched_at  INTEGER
				)
			`);
			sql.exec(`CREATE INDEX IF NOT EXISTS idx_waiting_enqueued ON waiting (enqueued_at)`);
			sql.exec(`CREATE INDEX IF NOT EXISTS idx_waiting_lease ON waiting (lease_until)`);
		});
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === 'POST' && url.pathname === '/enqueue') {
			return this.handleEnqueue(request);
		}
		if (request.method === 'GET' && url.pathname === '/status') {
			return this.handleStatus(url.searchParams.get('userId'));
		}
		if (request.method === 'DELETE' && url.pathname === '/cancel') {
			return this.handleCancel(url.searchParams.get('userId'));
		}
		return new Response('Not Found', { status: 404 });
	}

	private async handleEnqueue(request: Request): Promise<Response> {
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return Response.json({ error: { code: 'E_MALFORMED' } }, { status: 400 });
		}
		const parsed = v.safeParse(EnqueueBodySchema, body);
		if (!parsed.success) {
			return Response.json({ error: { code: 'E_MALFORMED' } }, { status: 400 });
		}
		const { userId, requestId } = parsed.output;
		const now = Date.now();

		const existing = this.ctx.storage.sql
			.exec<WaitingRow>(`SELECT * FROM waiting WHERE user_id = ?`, userId)
			.toArray()[0];

		// 冪等: 同じ requestId の再送、または既に待機中なら現状をそのまま返す。
		if (existing) {
			this.ensureAlarm();
			return Response.json(this.statusPayload(existing));
		}

		this.ctx.storage.sql.exec(
			`INSERT INTO waiting (user_id, request_id, enqueued_at, lease_until, match_id, matched_at)
			 VALUES (?, ?, ?, ?, NULL, NULL)`,
			userId,
			requestId,
			now,
			now + LEASE_MS
		);
		this.ensureAlarm();
		return Response.json({ status: 'waiting' });
	}

	private handleStatus(userId: string | null): Response {
		if (!userId) return Response.json({ error: { code: 'E_MALFORMED' } }, { status: 400 });
		const now = Date.now();
		const row = this.ctx.storage.sql
			.exec<WaitingRow>(`SELECT * FROM waiting WHERE user_id = ?`, userId)
			.toArray()[0];
		if (!row) return Response.json({ status: 'idle' });

		// ポーリングのたびに lease を延長する（matched 済みエントリは延長しない）。
		if (!row.match_id) {
			this.ctx.storage.sql.exec(
				`UPDATE waiting SET lease_until = ? WHERE user_id = ?`,
				now + LEASE_MS,
				userId
			);
		}
		return Response.json(this.statusPayload(row));
	}

	private handleCancel(userId: string | null): Response {
		if (!userId) return Response.json({ error: { code: 'E_MALFORMED' } }, { status: 400 });
		this.ctx.storage.sql.exec(`DELETE FROM waiting WHERE user_id = ? AND match_id IS NULL`, userId);
		return Response.json({ status: 'idle' });
	}

	private statusPayload(row: WaitingRow) {
		if (row.match_id) return { status: 'matched', matchId: row.match_id };
		return { status: 'waiting' };
	}

	private ensureAlarm(): void {
		// 既存の alarm を尊重しつつ、未設定なら即時にセットする。
		// wrangler のローカル実装では毎回 setAlarm しても安全（冪等）。
		this.ctx.storage.setAlarm(Date.now() + PAIRING_INTERVAL_MS);
	}

	/**
	 * `alarm()` は SQL 書き込みを **同期区間だけで完結**させ、`await` の後ろに
	 * SQL 書き込みを残さない。これは MatchRoom の act 処理と同じ規律
	 * （doc/designs/07-durable-objects.md 9.2「途中に await を挟まない」）を
	 * この DO にも適用したもの。
	 *
	 * 当初案は「ペアリング判定 → 非同期で /internal/init → 成功したら match_id を書く」
	 * という順序だった。しかし `await` の間、この DO は `/status`（lease 延長の
	 * UPDATE）や `/enqueue` からの別の同期呼び出しを受け付けられる状態のままであり、
	 * ローカルの Miniflare 環境では同一 DO の SQLite に対する書き込みが競合し、
	 * `SQLITE_BUSY` を引き起こすことを実機検証で確認した。
	 *
	 * 対策として、ペアリングの決定と `match_id` の確定は alarm 本体の同期区間で
	 * 先に行い、外部への通知（MatchRoom の初期化）だけを後段の非同期区間へ切り出す。
	 */
	async alarm(): Promise<void> {
		const now = Date.now();
		const sql = this.ctx.storage.sql;

		// 期限切れの未マッチエントリ（離脱とみなす）を除去する。
		sql.exec(`DELETE FROM waiting WHERE match_id IS NULL AND lease_until < ?`, now);
		// マッチ済みで一定時間 status を取得しに来なかったエントリも掃除する。
		sql.exec(
			`DELETE FROM waiting WHERE match_id IS NOT NULL AND matched_at < ?`,
			now - MATCHED_RETENTION_MS
		);

		const waiting = sql
			.exec<WaitingRow>(`SELECT * FROM waiting WHERE match_id IS NULL ORDER BY enqueued_at ASC`)
			.toArray();

		const pairs: { matchId: string; a: WaitingRow; b: WaitingRow }[] = [];
		for (let index = 0; index + 1 < waiting.length; index += 2) {
			const a = waiting[index];
			const b = waiting[index + 1];
			const matchId = crypto.randomUUID();
			// この UPDATE の時点で「マッチ済み」として確定させる。以後この2エントリは
			// `WHERE match_id IS NULL` の対象から外れ、後続の /status 等と衝突しない。
			sql.exec(
				`UPDATE waiting SET match_id = ?, matched_at = ? WHERE user_id IN (?, ?)`,
				matchId,
				now,
				a.user_id,
				b.user_id
			);
			pairs.push({ matchId, a, b });
		}

		const remaining = sql
			.exec<{ n: number }>(
				`SELECT COUNT(*) as n FROM waiting WHERE match_id IS NULL OR matched_at IS NOT NULL`
			)
			.toArray()[0];
		if (remaining && remaining.n > 0) {
			this.ctx.storage.setAlarm(now + PAIRING_INTERVAL_MS);
		}

		// ここから先は非同期。SQL 書き込みは行わない（読み取りも行わない）。
		for (const { matchId, a, b } of pairs) {
			await this.initMatchRoom(matchId, a, b);
		}
	}

	private async initMatchRoom(matchId: string, a: WaitingRow, b: WaitingRow): Promise<void> {
		const stub = this.env.MATCH_ROOM.get(this.env.MATCH_ROOM.idFromName(matchId));
		try {
			const response = await stub.fetch('http://match-room.internal/internal/init', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					matchId,
					mode: 'ranked_random',
					ruleVersion: RULE_VERSION,
					mapVersion: MAP_VERSION,
					seats: [
						{ seat: 0, userId: a.user_id },
						{ seat: 1, userId: b.user_id }
					]
				})
			});
			if (!response.ok) {
				// TODO(フェーズ5): 初期化失敗を検知・再試行する仕組みを追加する
				// （doc/designs/14-observability.md）。待機列側は既に matched 済みのため、
				// 現状は該当プレイヤーが ws-ticket 取得時に 404 を受け続ける形で顕在化する。
				console.error('MatchQueue: MatchRoom /internal/init returned', response.status, matchId);
			}
		} catch (error) {
			console.error('MatchQueue: MatchRoom /internal/init failed', matchId, error);
		}
	}
}
