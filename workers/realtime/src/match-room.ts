import { DurableObject } from 'cloudflare:workers';

/**
 * MatchRoom — 1試合につき1つ割り当てる Durable Object。対戦状態の「正」を保持する。
 *
 * 設計は doc/designs/07-durable-objects.md 9.2。要点:
 *   - 内蔵 SQLite が対戦の正本。`command_log` が決定論再現の唯一のソース（D-26）。
 *   - WebSocket は Hibernation API で受理し、`hello` の検証は **この DO 自身**が行う（D-24）。
 *   - 行動処理は SQLite の同期 API のみを使い、途中に await を挟まず原子性を保つ。
 *
 * フェーズ0ではストレージスキーマの作成と接続受理の骨組みのみを用意する。
 * 行動処理・チケット検証・再接続・永続化はフェーズ3で実装する。
 */

/** `hello` を受け取るまでの猶予（ミリ秒）。超過した接続は切断する。 */
export const AUTH_PENDING_TIMEOUT_MS = 5_000;

/** 接続に紐づけて保持する情報。ハイバネーション復帰後もこれで座席が分かる。 */
export interface ConnectionAttachment {
	matchId: string;
	connId: string;
	/** `hello` 検証に成功するまでは null。 */
	seat: number | null;
	userId: string | null;
	authenticated: boolean;
	acceptedAt: number;
}

export class MatchRoom extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);

		ctx.blockConcurrencyWhile(async () => {
			this.initSchema();
		});

		// ping/pong は DO を起こさずに応答する（課金と資源の節約）。
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
	}

	/** doc/designs/07-durable-objects.md 9.2 のスキーマ定義をそのまま反映する。 */
	private initSchema(): void {
		const sql = this.ctx.storage.sql;

		sql.exec(`
			CREATE TABLE IF NOT EXISTS match_state (
				id            INTEGER PRIMARY KEY CHECK (id = 1),
				match_id      TEXT NOT NULL,
				mode          TEXT NOT NULL,
				rule_version  TEXT NOT NULL,
				map_version   TEXT NOT NULL,
				seed          BLOB NOT NULL,
				status        TEXT NOT NULL,
				rev           INTEGER NOT NULL,
				round_no      INTEGER NOT NULL,
				active_seat   INTEGER NOT NULL,
				state_json    TEXT NOT NULL,
				started_at    INTEGER,
				ended_at      INTEGER,
				winner_seat   INTEGER,
				end_reason    TEXT
			)
		`);

		sql.exec(`
			CREATE TABLE IF NOT EXISTS seat (
				seat           INTEGER PRIMARY KEY,
				user_id        TEXT NOT NULL,
				connected      INTEGER NOT NULL DEFAULT 0,
				grace_until    INTEGER,
				timeout_streak INTEGER NOT NULL DEFAULT 0
			)
		`);

		// 受理した Command の原本。rev は Command 単位で単調増加する（D-26）。
		sql.exec(`
			CREATE TABLE IF NOT EXISTS command_log (
				rev          INTEGER PRIMARY KEY,
				ts           INTEGER NOT NULL,
				actor_seat   INTEGER,
				command_json TEXT NOT NULL,
				rule_version TEXT NOT NULL
			)
		`);

		// Event は command_log の派生物。1つの rev が複数の Event を生むため複合主キー。
		sql.exec(`
			CREATE TABLE IF NOT EXISTS event_log (
				rev        INTEGER NOT NULL,
				event_seq  INTEGER NOT NULL,
				event_json TEXT NOT NULL,
				PRIMARY KEY (rev, event_seq)
			)
		`);

		// 二重実行対策。同一 actionId の再送は記録済みの結果を返す。
		sql.exec(`
			CREATE TABLE IF NOT EXISTS action_log (
				action_id   TEXT PRIMARY KEY,
				seat        INTEGER NOT NULL,
				received_at INTEGER NOT NULL,
				base_rev    INTEGER NOT NULL,
				result_rev  INTEGER,
				outcome     TEXT NOT NULL,
				error_code  TEXT
			)
		`);

		// WS チケットの単回使用保証。
		sql.exec(`
			CREATE TABLE IF NOT EXISTS used_ticket (
				jti     TEXT PRIMARY KEY,
				used_at INTEGER NOT NULL
			)
		`);

		// 終局後の永続化状態。archived を確認するまで DO を削除しない（D-27）。
		sql.exec(`
			CREATE TABLE IF NOT EXISTS archive_state (
				id          INTEGER PRIMARY KEY CHECK (id = 1),
				status      TEXT NOT NULL DEFAULT 'pending',
				attempts    INTEGER NOT NULL DEFAULT 0,
				last_error  TEXT,
				archived_at INTEGER
			)
		`);
	}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('Expected websocket', { status: 426 });
		}

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);

		// `authPending` タグで受理し、hello 検証成功後に座席タグへ付け替える。
		// これにより getWebSockets('seat:0') のような取得ができる。
		this.ctx.acceptWebSocket(server, ['authPending']);

		const attachment: ConnectionAttachment = {
			matchId: new URL(request.url).pathname.split('/').pop() ?? '',
			connId: crypto.randomUUID(),
			seat: null,
			userId: null,
			authenticated: false,
			acceptedAt: Date.now()
		};
		server.serializeAttachment(attachment);

		// TODO(フェーズ3): authPending のまま AUTH_PENDING_TIMEOUT_MS を超えた接続を
		// alarm で切断する（doc/designs/07-durable-objects.md 9.2）。

		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
		// TODO(フェーズ3): 以下を実装する（doc/designs/07-durable-objects.md 9.2 の処理シーケンス）
		//   1. メッセージサイズ / 頻度チェック
		//   2. Valibot による厳格検証（未定義キー拒否）
		//   3. hello: チケット署名・exp・mid・jti 単回使用・座席の検証（この DO 自身が行う）
		//   4. act:  actionId 冪等化 → status → active_seat → baseRev → applyCommand
		//   5. 射影して actionResult / events を配信
		ws.close(1011, 'not implemented yet');
	}

	async webSocketClose(
		ws: WebSocket,
		code: number,
		reason: string,
		_wasClean: boolean
	): Promise<void> {
		// TODO(フェーズ3): 座席の connected を落とし、切断猶予の alarm を設定する。
		ws.close(code, reason);
	}

	async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
		console.error('MatchRoom websocket error', error);
	}
}
