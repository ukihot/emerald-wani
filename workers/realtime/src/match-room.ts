import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import {
	applyAction,
	completeDeployment,
	concede,
	createGame,
	endTurn,
	isSupportedMapVersion,
	isSupportedRuleVersion,
	projectState,
	submitDeployment,
	type DeploymentPlacement,
	type GameEvent,
	type GameResult,
	type GameState,
	type Seat,
	type StateChange
} from '$game/index';
import {
	AUTH_PENDING_TIMEOUT_MS,
	ClientMessageSchema,
	MAX_CONSECUTIVE_INVALID,
	MAX_MESSAGE_BYTES,
	RATE_LIMIT_MESSAGES,
	RATE_LIMIT_WINDOW_MS,
	type ClientMessage,
	type Command,
	type ErrorCode
} from '$protocol/ws';
import { REPLAY_FORMAT_VERSION, type ReplayEntry, type ReplayHeader } from '$protocol/replay';
import { secretsFromEnv, verifyTicket } from '$protocol/ws-ticket';
import { upsertMatchResult } from './archive';

/**
 * MatchRoom — 1試合につき1つ割り当てる Durable Object。対戦状態の「正」を保持する。
 *
 * 設計は doc/designs/07-durable-objects.md 9.2、doc/designs/09-api-protocol.md、
 * doc/designs/06-rule-engine.md。要点:
 *   - 内蔵 SQLite が対戦の正本。`command_log` が決定論再現の唯一のソース。
 *   - WebSocket は Hibernation API で受理し、`hello` の検証は **この DO 自身**が行う。
 *   - 行動処理は SQLite の同期 API のみを使い、途中に await を挟まず原子性を保つ。
 *
 * `src/lib/game/engine.ts` は単一の `applyCommand` ディスパッチャを公開していない
 * （`submitDeployment` / `applyAction` / `endTurn` / `concede` が個別の純粋関数）。
 * この DO 自身が「受理した Command を1つ選び、対応するエンジン関数を1回だけ呼ぶ」
 * ディスパッチャを担い、その呼び出し単位で rev を1増やす。
 *
 * フェーズ5で追加したもの:
 *   - 終局後のアーカイブ（D1 への結果書き込み、Queue 送出、/internal/export、
 *     /internal/archive-complete、archived 確認後の掃除）
 *
 * まだ実装していないもの:
 *   - security_event への異常系の永続化（フェーズ6。今は console.error のみ）
 *   - CPU練習戦（座席1をCPUにする /internal/init の mode='cpu'）
 */

interface ConnectionAttachment {
	matchId: string;
	connId: string;
	seat: Seat | null;
	userId: string | null;
	authenticated: boolean;
	acceptedAt: number;
}

interface MatchStateRow extends Record<string, SqlStorageValue> {
	id: 1;
	match_id: string;
	mode: string;
	rule_version: string;
	map_version: string;
	seed: string;
	status: 'deployment' | 'playing' | 'finished' | 'void';
	rev: number;
	round_no: number;
	active_seat: number;
	state_json: string;
	started_at: number;
	ended_at: number | null;
	winner_seat: number | null;
	end_reason: string | null;
	deployment_deadline: number | null;
	turn_deadline: number | null;
}

interface SeatRow extends Record<string, SqlStorageValue> {
	seat: 0 | 1;
	user_id: string;
	connected: number;
	active_conn_id: string | null;
	timeout_streak: number;
}

interface ArchiveStateRow extends Record<string, SqlStorageValue> {
	id: 1;
	status: 'pending' | 'archived' | 'failed' | 'cleaned';
	attempts: number;
	last_error: string | null;
	archived_at: number | null;
}

interface ActionLogRow extends Record<string, SqlStorageValue> {
	action_id: string;
	seat: number;
	base_rev: number;
	result_rev: number | null;
	outcome: 'applied' | 'rejected';
	error_code: string | null;
	response_json: string;
}

const InitBodySchema = v.strictObject({
	matchId: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
	mode: v.picklist(['ranked_random', 'friend', 'cpu']),
	ruleVersion: v.pipe(v.string(), v.minLength(1), v.maxLength(32)),
	mapVersion: v.pipe(v.string(), v.minLength(1), v.maxLength(32)),
	seats: v.pipe(
		v.array(
			v.strictObject({
				seat: v.union([v.literal(0), v.literal(1)]),
				userId: v.pipe(v.string(), v.minLength(1), v.maxLength(128))
			})
		),
		v.length(2)
	)
});

type WsEnvelope =
	| { t: 'welcome'; rev: number; seat: Seat; view: GameState; deadlines: Deadlines }
	| {
			t: 'actionResult';
			actionId: string;
			fromRev: number;
			toRev: number;
			events: EventBatch[];
	  }
	| { t: 'events'; fromRev: number; toRev: number; events: EventBatch[] }
	| { t: 'error'; actionId?: string; code: ErrorCode; message: string }
	| { t: 'opponent'; status: 'connected' | 'disconnected' }
	| { t: 'finished'; winnerSeat: Seat | null; endReason: string | null; summary: GameState };

interface EventBatch {
	rev: number;
	actorSeat: number | null;
	events: GameEvent[];
}

/**
 * 終局から DO の掃除までの最短待ち時間（doc/designs/07-durable-objects.md 9.2）。
 * この時間内は結果閲覧のために WS と状態を保持する。
 */
const ARCHIVE_CLEANUP_MIN_DELAY_MS = 10 * 60 * 1000;

interface Deadlines {
	deploymentEndsAt: number | null;
	turnEndsAt: number | null;
}

export class MatchRoom extends DurableObject<Env> {
	/** connId ごとの直近メッセージ受信時刻（送信頻度チェック用。DO内メモリで十分）。 */
	private messageTimestamps = new Map<string, number[]>();
	/** connId ごとの連続無効メッセージ数。 */
	private invalidStreaks = new Map<string, number>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);

		ctx.blockConcurrencyWhile(async () => {
			this.initSchema();
		});

		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
	}

	private initSchema(): void {
		const sql = this.ctx.storage.sql;

		sql.exec(`
			CREATE TABLE IF NOT EXISTS match_state (
				id                  INTEGER PRIMARY KEY CHECK (id = 1),
				match_id            TEXT NOT NULL,
				mode                TEXT NOT NULL,
				rule_version        TEXT NOT NULL,
				map_version         TEXT NOT NULL,
				seed                TEXT NOT NULL,
				status              TEXT NOT NULL,
				rev                 INTEGER NOT NULL,
				round_no            INTEGER NOT NULL,
				active_seat         INTEGER NOT NULL,
				state_json          TEXT NOT NULL,
				started_at          INTEGER NOT NULL,
				ended_at            INTEGER,
				winner_seat         INTEGER,
				end_reason          TEXT,
				deployment_deadline INTEGER,
				turn_deadline       INTEGER
			)
		`);

		sql.exec(`
			CREATE TABLE IF NOT EXISTS seat (
				seat           INTEGER PRIMARY KEY,
				user_id        TEXT NOT NULL,
				connected      INTEGER NOT NULL DEFAULT 0,
				active_conn_id TEXT,
				timeout_streak INTEGER NOT NULL DEFAULT 0
			)
		`);

		sql.exec(`
			CREATE TABLE IF NOT EXISTS command_log (
				rev          INTEGER PRIMARY KEY,
				ts           INTEGER NOT NULL,
				actor_seat   INTEGER,
				command_json TEXT NOT NULL,
				rule_version TEXT NOT NULL
			)
		`);

		sql.exec(`
			CREATE TABLE IF NOT EXISTS event_log (
				rev        INTEGER NOT NULL,
				event_seq  INTEGER NOT NULL,
				event_json TEXT NOT NULL,
				PRIMARY KEY (rev, event_seq)
			)
		`);

		sql.exec(`
			CREATE TABLE IF NOT EXISTS action_log (
				action_id     TEXT PRIMARY KEY,
				seat          INTEGER NOT NULL,
				received_at   INTEGER NOT NULL,
				base_rev      INTEGER NOT NULL,
				result_rev    INTEGER,
				outcome       TEXT NOT NULL,
				error_code    TEXT,
				response_json TEXT NOT NULL
			)
		`);

		sql.exec(`
			CREATE TABLE IF NOT EXISTS used_ticket (
				jti     TEXT PRIMARY KEY,
				used_at INTEGER NOT NULL
			)
		`);

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

	// ── HTTP: 内部API と WS Upgrade ─────────────────────────────────────────

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === 'POST' && url.pathname === '/internal/init') {
			return this.handleInit(request);
		}
		if (request.method === 'GET' && url.pathname === '/internal/seat') {
			return this.handleSeatLookup(url.searchParams.get('userId'));
		}
		if (request.method === 'GET' && url.pathname === '/internal/export') {
			return this.handleExport();
		}
		if (request.method === 'POST' && url.pathname === '/internal/archive-complete') {
			return this.handleArchiveComplete(request);
		}
		if (request.method === 'POST' && url.pathname === '/internal/archive-failed') {
			return this.handleArchiveFailed(request);
		}

		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('Expected websocket', { status: 426 });
		}
		return this.handleUpgrade(request);
	}

	/** MatchQueue（同一Worker内バインディング経由）だけが呼ぶ。試合を初期化する。 */
	private async handleInit(request: Request): Promise<Response> {
		if (this.readMatchState()) {
			// 二重初期化はエラーにせず、既存状態を成功として扱う（呼び出し側の再試行に強くする）。
			return Response.json({ ok: true, alreadyInitialized: true });
		}

		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return Response.json({ ok: false, error: 'E_MALFORMED' }, { status: 400 });
		}
		const parsed = v.safeParse(InitBodySchema, body);
		if (!parsed.success) return Response.json({ ok: false, error: 'E_MALFORMED' }, { status: 400 });
		const input = parsed.output;

		if (!isSupportedRuleVersion(input.ruleVersion) || !isSupportedMapVersion(input.mapVersion)) {
			return Response.json({ ok: false, error: 'E_RULE_VERSION_UNSUPPORTED' }, { status: 400 });
		}
		const seatsBySeat = new Map(input.seats.map((entry) => [entry.seat, entry.userId]));
		if (seatsBySeat.size !== 2 || !seatsBySeat.has(0) || !seatsBySeat.has(1)) {
			return Response.json({ ok: false, error: 'E_MALFORMED' }, { status: 400 });
		}

		const seed = randomSeedHex();
		const state = createGame(seed);
		const now = Date.now();
		const deploymentDeadline = now + 45_000;

		this.ctx.storage.sql.exec(
			`INSERT INTO match_state
			 (id, match_id, mode, rule_version, map_version, seed, status, rev, round_no,
			  active_seat, state_json, started_at, deployment_deadline, turn_deadline)
			 VALUES (1, ?, ?, ?, ?, ?, 'deployment', 1, ?, ?, ?, ?, ?, NULL)`,
			input.matchId,
			input.mode,
			state.ruleVersion,
			state.mapVersion,
			seed,
			state.round,
			state.activeSeat,
			JSON.stringify(state),
			now,
			deploymentDeadline
		);
		for (const [seat, userId] of seatsBySeat) {
			this.ctx.storage.sql.exec(
				`INSERT INTO seat (seat, user_id, connected, active_conn_id, timeout_streak)
				 VALUES (?, ?, 0, NULL, 0)`,
				seat,
				userId
			);
		}
		this.ctx.storage.sql.exec(
			`INSERT INTO command_log (rev, ts, actor_seat, command_json, rule_version)
			 VALUES (1, ?, NULL, ?, ?)`,
			now,
			JSON.stringify({
				type: 'sys.startMatch',
				seed,
				ruleVersion: input.ruleVersion,
				mapVersion: input.mapVersion
			}),
			state.ruleVersion
		);
		this.ctx.storage.sql.exec(`INSERT INTO archive_state (id, status) VALUES (1, 'pending')`);

		this.scheduleNextAlarm(deploymentDeadline);

		return Response.json({ ok: true });
	}

	/** web Worker がチケット発行前に呼ぶ。参加者でなければ `seat: null`。 */
	private handleSeatLookup(userId: string | null): Response {
		if (!userId) return Response.json({ seat: null }, { status: 400 });
		const row = this.ctx.storage.sql
			.exec<SeatRow>(`SELECT * FROM seat WHERE user_id = ?`, userId)
			.toArray()[0];
		const matchState = this.readMatchState();
		return Response.json({
			seat: row?.seat ?? null,
			ruleVersion: matchState?.rule_version ?? null,
			status: matchState?.status ?? null
		});
	}

	private handleUpgrade(request: Request): Response {
		const matchId = new URL(request.url).pathname.split('/').pop() ?? '';
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);

		this.ctx.acceptWebSocket(server, ['authPending']);

		const attachment: ConnectionAttachment = {
			matchId,
			connId: crypto.randomUUID(),
			seat: null,
			userId: null,
			authenticated: false,
			acceptedAt: Date.now()
		};
		server.serializeAttachment(attachment);

		// authPending のまま長時間置かれた接続を掃除できるよう、最も早い期限として検討させる。
		this.scheduleNextAlarm(attachment.acceptedAt + AUTH_PENDING_TIMEOUT_MS);

		return new Response(null, { status: 101, webSocket: client });
	}

	// ── WebSocket ハンドラ ───────────────────────────────────────────────

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const attachment = ws.deserializeAttachment() as ConnectionAttachment;
		const raw = typeof message === 'string' ? message : new TextDecoder().decode(message);

		if (new TextEncoder().encode(raw).byteLength > MAX_MESSAGE_BYTES) {
			ws.close(1009, 'message too large');
			return;
		}

		let parsedJson: unknown;
		try {
			parsedJson = JSON.parse(raw);
		} catch {
			this.registerInvalid(ws, attachment);
			return;
		}

		const parsed = v.safeParse(ClientMessageSchema, parsedJson);
		if (!parsed.success) {
			this.registerInvalid(ws, attachment);
			return;
		}
		this.invalidStreaks.delete(attachment.connId);

		if (!this.checkRate(attachment.connId)) {
			this.send(ws, { t: 'error', code: 'E_RATE_LIMITED', message: '送信頻度が高すぎます' });
			return;
		}

		const envelope = parsed.output;
		if (envelope.t === 'hello') {
			await this.handleHello(ws, attachment, envelope);
			return;
		}

		if (!attachment.authenticated || attachment.seat === null) {
			this.send(ws, { t: 'error', code: 'E_UNAUTHENTICATED', message: '認証が必要です' });
			return;
		}

		if (envelope.t === 'resync') {
			this.sendWelcome(ws, attachment.seat);
			return;
		}
		if (envelope.t === 'act') {
			this.handleAct(ws, attachment.seat, envelope);
		}
	}

	async webSocketClose(ws: WebSocket): Promise<void> {
		const attachment = ws.deserializeAttachment() as ConnectionAttachment;
		this.messageTimestamps.delete(attachment.connId);
		this.invalidStreaks.delete(attachment.connId);
		if (attachment.seat === null) return;

		const seatRow = this.ctx.storage.sql
			.exec<SeatRow>(`SELECT * FROM seat WHERE seat = ?`, attachment.seat)
			.toArray()[0];
		// 既に別接続（再接続後）に置き換わっている場合は、この古い接続のクローズを無視する。
		if (!seatRow || seatRow.active_conn_id !== attachment.connId) return;

		this.ctx.storage.sql.exec(`UPDATE seat SET connected = 0 WHERE seat = ?`, attachment.seat);
		this.broadcastExcept(attachment.seat, {
			t: 'opponent',
			status: 'disconnected'
		});
		// 手番タイマーは止めない（doc/designs/07-durable-objects.md 9.2）。
		// 通常の30秒タイムアウトと3連続失格ルールがそのまま適用される。
	}

	async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
		console.error('MatchRoom websocket error', error);
		await this.webSocketClose(ws);
	}

	// ── hello（認証） ────────────────────────────────────────────────────

	private async handleHello(
		ws: WebSocket,
		attachment: ConnectionAttachment,
		envelope: Extract<ClientMessage, { t: 'hello' }>
	): Promise<void> {
		const now = Date.now();
		const secrets = secretsFromEnv(this.env as unknown as Record<string, unknown>);
		const result = await verifyTicket(envelope.ticket, secrets, now);
		if (!result.ok) {
			ws.close(4001, `invalid ticket: ${result.reason}`);
			return;
		}
		const { payload } = result;
		if (payload.mid !== attachment.matchId) {
			ws.close(4001, 'ticket match mismatch');
			return;
		}

		const alreadyUsed = this.ctx.storage.sql
			.exec<{ jti: string }>(`SELECT jti FROM used_ticket WHERE jti = ?`, payload.jti)
			.toArray()[0];
		if (alreadyUsed) {
			ws.close(4001, 'ticket already used');
			return;
		}

		const seatRow = this.ctx.storage.sql
			.exec<SeatRow>(`SELECT * FROM seat WHERE seat = ?`, payload.seat)
			.toArray()[0];
		if (!seatRow || seatRow.user_id !== payload.uid) {
			ws.close(4003, 'not a participant');
			return;
		}

		this.ctx.storage.sql.exec(
			`INSERT INTO used_ticket (jti, used_at) VALUES (?, ?)`,
			payload.jti,
			now
		);

		// 同じ座席の既存接続があれば置き換える（design: 1座席1接続）。
		// 引数なしの getWebSockets() は tag を問わず全接続を返す
		// （'authPending' タグは付け替えていないため、tag指定では認証済み接続を拾えない）。
		for (const existing of this.ctx.getWebSockets()) {
			if (existing === ws) continue;
			const existingAttachment = existing.deserializeAttachment() as ConnectionAttachment;
			if (existingAttachment.seat === payload.seat) {
				try {
					existing.close(4000, 'superseded');
				} catch {
					/* 既に閉じている場合は無視する */
				}
			}
		}

		attachment.authenticated = true;
		attachment.seat = payload.seat as Seat;
		attachment.userId = payload.uid;
		ws.serializeAttachment(attachment);

		this.ctx.storage.sql.exec(
			`UPDATE seat SET connected = 1, active_conn_id = ? WHERE seat = ?`,
			attachment.connId,
			payload.seat
		);

		this.broadcastExcept(attachment.seat, { t: 'opponent', status: 'connected' });
		this.sendWelcome(ws, attachment.seat);

		if (typeof envelope.lastRev === 'number') {
			this.sendReplaySince(ws, attachment.seat, envelope.lastRev);
		}
	}

	private sendWelcome(ws: WebSocket, seat: Seat): void {
		const row = this.readMatchState();
		if (!row) return;
		const state = JSON.parse(row.state_json) as GameState;
		this.send(ws, {
			t: 'welcome',
			rev: row.rev,
			seat,
			view: projectState(state, seat),
			deadlines: {
				deploymentEndsAt: row.deployment_deadline,
				turnEndsAt: row.turn_deadline
			}
		});
	}

	private sendReplaySince(ws: WebSocket, seat: Seat, lastRev: number): void {
		const row = this.readMatchState();
		if (!row) return;
		if (lastRev >= row.rev || row.rev - lastRev > 200) return; // welcome の完全スナップショットで足りる
		const rows = this.ctx.storage.sql
			.exec<{ rev: number; event_seq: number; event_json: string }>(
				`SELECT rev, event_seq, event_json FROM event_log WHERE rev > ? ORDER BY rev, event_seq`,
				lastRev
			)
			.toArray();
		if (rows.length === 0) return;

		const actorBySeatRev = new Map<number, number | null>(
			this.ctx.storage.sql
				.exec<{ rev: number; actor_seat: number | null }>(
					`SELECT rev, actor_seat FROM command_log WHERE rev > ?`,
					lastRev
				)
				.toArray()
				.map((entry) => [entry.rev, entry.actor_seat])
		);
		const batches = groupIntoBatches(rows, actorBySeatRev);
		this.send(ws, {
			t: 'events',
			fromRev: lastRev + 1,
			toRev: row.rev,
			events: batches
		});
	}

	// ── act（行動） ──────────────────────────────────────────────────────

	private handleAct(
		ws: WebSocket,
		seat: Seat,
		envelope: Extract<ClientMessage, { t: 'act' }>
	): void {
		const existingAction = this.ctx.storage.sql
			.exec<ActionLogRow>(`SELECT * FROM action_log WHERE action_id = ?`, envelope.actionId)
			.toArray()[0];
		if (existingAction) {
			this.send(ws, JSON.parse(existingAction.response_json) as WsEnvelope);
			return;
		}

		const row = this.readMatchState();
		if (!row) {
			this.send(ws, {
				t: 'error',
				actionId: envelope.actionId,
				code: 'E_INTERNAL',
				message: '試合が見つかりません'
			});
			return;
		}

		if (row.status === 'finished' || row.status === 'void') {
			this.rejectAction(
				seat,
				envelope.actionId,
				row.rev,
				'E_MATCH_FINISHED',
				'対局は終了しています',
				ws
			);
			return;
		}

		const state = JSON.parse(row.state_json) as GameState;

		if (state.phase === 'playing' && state.activeSeat !== seat) {
			this.rejectAction(
				seat,
				envelope.actionId,
				row.rev,
				'E_NOT_YOUR_TURN',
				'あなたの手番ではありません',
				ws
			);
			return;
		}

		if (envelope.baseRev !== row.rev) {
			this.rejectAction(
				seat,
				envelope.actionId,
				row.rev,
				'E_STALE_REV',
				'状態が古くなっています',
				ws
			);
			return;
		}

		const dispatched = dispatchCommand(state, seat, envelope.action);
		if (!dispatched.ok) {
			this.rejectAction(
				seat,
				envelope.actionId,
				row.rev,
				dispatched.errorCode,
				dispatched.error,
				ws
			);
			return;
		}

		const { state: nextState, events } = dispatched.value;
		const nextRev = row.rev + 1;
		const now = Date.now();

		this.ctx.storage.sql.exec(
			`INSERT INTO command_log (rev, ts, actor_seat, command_json, rule_version)
			 VALUES (?, ?, ?, ?, ?)`,
			nextRev,
			now,
			seat,
			JSON.stringify(envelope.action),
			nextState.ruleVersion
		);
		events.forEach((event, index) => {
			this.ctx.storage.sql.exec(
				`INSERT INTO event_log (rev, event_seq, event_json) VALUES (?, ?, ?)`,
				nextRev,
				index,
				JSON.stringify(event)
			);
		});

		const deploymentDeadline = nextState.phase === 'deployment' ? row.deployment_deadline : null;
		const turnDeadline = nextState.phase === 'playing' ? now + 30_000 : null;
		const finished = nextState.phase === 'finished';

		this.ctx.storage.sql.exec(
			`UPDATE match_state SET
				rev = ?, round_no = ?, active_seat = ?, status = ?, state_json = ?,
				deployment_deadline = ?, turn_deadline = ?, ended_at = ?, winner_seat = ?, end_reason = ?
			 WHERE id = 1`,
			nextRev,
			nextState.round,
			nextState.activeSeat,
			finished ? 'finished' : nextState.phase,
			JSON.stringify(nextState),
			deploymentDeadline,
			turnDeadline,
			finished ? now : null,
			finished ? seatValue(nextState.winner) : null,
			finished ? nextState.endReason : null
		);

		const actionResult: WsEnvelope = {
			t: 'actionResult',
			actionId: envelope.actionId,
			fromRev: row.rev + 1,
			toRev: nextRev,
			events: [{ rev: nextRev, actorSeat: seat, events }]
		};
		this.ctx.storage.sql.exec(
			`INSERT INTO action_log (action_id, seat, received_at, base_rev, result_rev, outcome, error_code, response_json)
			 VALUES (?, ?, ?, ?, ?, 'applied', NULL, ?)`,
			envelope.actionId,
			seat,
			now,
			envelope.baseRev,
			nextRev,
			JSON.stringify(actionResult)
		);

		this.send(ws, actionResult);
		this.broadcastExcept(seat, {
			t: 'events',
			fromRev: row.rev + 1,
			toRev: nextRev,
			events: [{ rev: nextRev, actorSeat: seat, events }]
		});

		if (finished) {
			this.broadcastAll({
				t: 'finished',
				winnerSeat: seatValue(nextState.winner),
				endReason: nextState.endReason,
				summary: nextState
			});
			this.onMatchFinished(now);
			return;
		}

		this.scheduleNextAlarm(deploymentDeadline ?? turnDeadline);
	}

	private rejectAction(
		seat: Seat,
		actionId: string,
		rev: number,
		code: ErrorCode,
		message: string,
		ws: WebSocket
	): void {
		const response: WsEnvelope = { t: 'error', actionId, code, message };
		this.ctx.storage.sql.exec(
			`INSERT INTO action_log (action_id, seat, received_at, base_rev, result_rev, outcome, error_code, response_json)
			 VALUES (?, ?, ?, ?, NULL, 'rejected', ?, ?)`,
			actionId,
			seat,
			Date.now(),
			rev,
			code,
			JSON.stringify(response)
		);
		this.send(ws, response);
	}

	// ── alarm（布陣/ターン時間切れ、authPending掃除） ───────────────────

	async alarm(): Promise<void> {
		const now = Date.now();
		const row = this.readMatchState();

		// 認証待ちのまま期限切れの接続を閉じる。
		for (const ws of this.ctx.getWebSockets('authPending')) {
			const attachment = ws.deserializeAttachment() as ConnectionAttachment;
			if (!attachment.authenticated && now - attachment.acceptedAt >= AUTH_PENDING_TIMEOUT_MS) {
				try {
					ws.close(4008, 'hello timeout');
				} catch {
					/* noop */
				}
			}
		}

		if (!row) return;
		if (row.status === 'finished' || row.status === 'void') {
			this.cleanupIfArchived(row, now);
			return;
		}

		const state = JSON.parse(row.state_json) as GameState;

		if (
			state.phase === 'deployment' &&
			row.deployment_deadline !== null &&
			now >= row.deployment_deadline
		) {
			this.applySystemDeploymentTimeout(row, state, now);
			return;
		}
		if (state.phase === 'playing' && row.turn_deadline !== null && now >= row.turn_deadline) {
			this.applySystemTurnTimeout(row, state, now);
			return;
		}

		this.scheduleNextAlarm(
			state.phase === 'deployment' ? row.deployment_deadline : row.turn_deadline
		);
	}

	private applySystemDeploymentTimeout(row: MatchStateRow, state: GameState, now: number): void {
		let current = state;
		const events: GameEvent[] = [];
		for (const seat of [0, 1] as const) {
			if (current.deploymentConfirmed[seat]) continue;
			const completed = completeDeployment(current, seat, []);
			const result = submitDeployment(current, seat, completed);
			if (!result.ok) {
				console.error('deployment timeout auto-complete failed', result.error);
				continue;
			}
			current = result.value.state;
			events.push(...result.value.events);
		}
		this.commitSystemCommand(row, { type: 'sys.deploymentTimeout' }, current, events, now);
	}

	private applySystemTurnTimeout(row: MatchStateRow, state: GameState, now: number): void {
		const result = endTurn(state, true);
		if (!result.ok) {
			console.error('turn timeout failed', result.error);
			return;
		}
		this.commitSystemCommand(
			row,
			{ type: 'sys.turnTimeout', seat: state.activeSeat },
			result.value.state,
			result.value.events,
			now
		);
	}

	/** alarm 起因のシステム Command を1件のトランザクションとして確定する。 */
	private commitSystemCommand(
		row: MatchStateRow,
		command: Record<string, unknown>,
		nextState: GameState,
		events: GameEvent[],
		now: number
	): void {
		const nextRev = row.rev + 1;
		this.ctx.storage.sql.exec(
			`INSERT INTO command_log (rev, ts, actor_seat, command_json, rule_version)
			 VALUES (?, ?, NULL, ?, ?)`,
			nextRev,
			now,
			JSON.stringify(command),
			nextState.ruleVersion
		);
		events.forEach((event, index) => {
			this.ctx.storage.sql.exec(
				`INSERT INTO event_log (rev, event_seq, event_json) VALUES (?, ?, ?)`,
				nextRev,
				index,
				JSON.stringify(event)
			);
		});

		const finished = nextState.phase === 'finished';
		const deploymentDeadline = nextState.phase === 'deployment' ? row.deployment_deadline : null;
		const turnDeadline = nextState.phase === 'playing' ? now + 30_000 : null;

		this.ctx.storage.sql.exec(
			`UPDATE match_state SET
				rev = ?, round_no = ?, active_seat = ?, status = ?, state_json = ?,
				deployment_deadline = ?, turn_deadline = ?, ended_at = ?, winner_seat = ?, end_reason = ?
			 WHERE id = 1`,
			nextRev,
			nextState.round,
			nextState.activeSeat,
			finished ? 'finished' : nextState.phase,
			JSON.stringify(nextState),
			deploymentDeadline,
			turnDeadline,
			finished ? now : null,
			finished ? seatValue(nextState.winner) : null,
			finished ? nextState.endReason : null
		);

		const batch: EventBatch[] = [{ rev: nextRev, actorSeat: null, events }];
		this.broadcastAll({ t: 'events', fromRev: row.rev + 1, toRev: nextRev, events: batch });
		if (finished) {
			this.broadcastAll({
				t: 'finished',
				winnerSeat: seatValue(nextState.winner),
				endReason: nextState.endReason,
				summary: nextState
			});
			this.onMatchFinished(now);
			return;
		}
		this.scheduleNextAlarm(deploymentDeadline ?? turnDeadline);
	}

	// ── 終局後の永続化（アーカイブ） ─────────────────────────────────────

	/**
	 * 終局直後の処理（doc/designs/07-durable-objects.md 9.2）。
	 *
	 * WS はここでは閉じない（結果閲覧のため一定時間維持する）。DO の SQLite は
	 * `archive_state.status = 'archived'` を確認できるまで消さない。
	 */
	private onMatchFinished(now: number): void {
		this.ctx.storage.sql.exec(`UPDATE archive_state SET status = 'pending' WHERE id = 1`);
		this.scheduleNextAlarm(now + ARCHIVE_CLEANUP_MIN_DELAY_MS);
		// Queue への送出と D1 への結果書き込みは非同期。ここで失敗しても DO の
		// SQLite は保持されたままなので、Cron のフォールバックが拾い直せる。
		this.ctx.waitUntil(this.announceFinished());
	}

	private async announceFinished(): Promise<void> {
		const row = this.readMatchState();
		if (!row) return;
		const header = this.buildReplayHeader(row);

		// 先に D1 へ結果を書く。リプレイ本体（replay_key）は consumer が後から埋める。
		// この行が「アーカイブ未完了の対戦」の発見手段になる（Cron のスキャン対象）。
		try {
			await upsertMatchResult(this.env, header);
		} catch (error) {
			console.error('MatchRoom: failed to record match result in D1', error);
		}

		try {
			// Queue には matchId だけを送る。ログ本体は consumer が /internal/export から
			// 取得する（128KB のメッセージ上限を避ける。doc/designs/07-durable-objects.md 9.2）。
			await this.env.MATCH_EVENTS.send({ matchId: row.match_id });
		} catch (error) {
			console.error('MatchRoom: failed to enqueue archive job', error);
		}
	}

	/**
	 * consumer と Cron フォールバックだけが呼ぶ内部限定エクスポート。
	 *
	 * DO は外部から直接叩けない（realtime Worker のバインディング経由のみ）ため、
	 * このパスに追加の認証は置かない（doc/designs/02-architecture.md 3.3）。
	 * 1試合の command_log は数百件規模のため、ストリーミングせず1レスポンスで返す。
	 */
	private handleExport(): Response {
		const row = this.readMatchState();
		if (!row) return Response.json({ error: 'not_found' }, { status: 404 });
		if (row.status !== 'finished' && row.status !== 'void') {
			return Response.json({ error: 'not_finished' }, { status: 409 });
		}

		const commands = this.ctx.storage.sql
			.exec<{ rev: number; ts: number; actor_seat: number | null; command_json: string }>(
				`SELECT rev, ts, actor_seat, command_json FROM command_log ORDER BY rev`
			)
			.toArray();
		const eventRows = this.ctx.storage.sql
			.exec<{ rev: number; event_seq: number; event_json: string }>(
				`SELECT rev, event_seq, event_json FROM event_log ORDER BY rev, event_seq`
			)
			.toArray();

		const eventsByRev = new Map<number, GameEvent[]>();
		for (const event of eventRows) {
			const list = eventsByRev.get(event.rev) ?? [];
			list[event.event_seq] = JSON.parse(event.event_json) as GameEvent;
			eventsByRev.set(event.rev, list);
		}

		const entries: ReplayEntry[] = commands.map((command) => ({
			rev: command.rev,
			ts: command.ts,
			actorSeat: command.actor_seat === null ? null : (command.actor_seat as Seat),
			command: JSON.parse(command.command_json) as Record<string, unknown>,
			events: eventsByRev.get(command.rev) ?? []
		}));

		return Response.json({ header: this.buildReplayHeader(row), entries });
	}

	private async handleArchiveComplete(request: Request): Promise<Response> {
		const body = (await request.json().catch(() => null)) as { replayKey?: string } | null;
		if (!body?.replayKey) return Response.json({ ok: false }, { status: 400 });

		const now = Date.now();
		this.ctx.storage.sql.exec(
			`UPDATE archive_state SET status = 'archived', last_error = NULL, archived_at = ? WHERE id = 1`,
			now
		);
		const row = this.readMatchState();
		this.scheduleNextAlarm((row?.ended_at ?? now) + ARCHIVE_CLEANUP_MIN_DELAY_MS);
		return Response.json({ ok: true });
	}

	private async handleArchiveFailed(request: Request): Promise<Response> {
		const body = (await request.json().catch(() => null)) as { error?: string } | null;
		this.ctx.storage.sql.exec(
			`UPDATE archive_state SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE id = 1`,
			(body?.error ?? 'unknown').slice(0, 500)
		);
		return Response.json({ ok: true });
	}

	/**
	 * 終局後の掃除。`archived` を確認できた後、かつ終局から最短10分で実行する。
	 *
	 * 設計文書は「DO の SQLite を削除する」としているが、`storage.deleteAll()` は
	 * `archive_state` の記録ごと消してしまい、掃除済みかどうかを後から確認できない。
	 * ここでは容量を占める表を明示的に空にし、`archive_state` を `cleaned` の
	 * 墓標として残す（対戦IDはランダムなので再利用されない）。
	 */
	private cleanupIfArchived(row: MatchStateRow, now: number): void {
		const archive = this.ctx.storage.sql
			.exec<ArchiveStateRow>(`SELECT * FROM archive_state WHERE id = 1`)
			.toArray()[0];
		if (!archive || archive.status === 'cleaned') return;
		if (archive.status !== 'archived') {
			// pending / failed のあいだは決して消さない。Queue のリトライと Cron の
			// フォールバックが完了を報告するまで DO 側が唯一の正本である。
			return;
		}

		const cleanupAt = (row.ended_at ?? now) + ARCHIVE_CLEANUP_MIN_DELAY_MS;
		if (now < cleanupAt) {
			this.scheduleNextAlarm(cleanupAt);
			return;
		}

		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.close(1000, 'match archived');
			} catch {
				/* 既に閉じている場合は無視する */
			}
		}
		for (const table of ['command_log', 'event_log', 'action_log', 'used_ticket']) {
			this.ctx.storage.sql.exec(`DELETE FROM ${table}`);
		}
		this.ctx.storage.sql.exec(`UPDATE archive_state SET status = 'cleaned' WHERE id = 1`);
	}

	private readSeats(): SeatRow[] {
		return this.ctx.storage.sql.exec<SeatRow>(`SELECT * FROM seat ORDER BY seat`).toArray();
	}

	private buildReplayHeader(row: MatchStateRow): ReplayHeader {
		const state = JSON.parse(row.state_json) as GameState;
		const winnerSeat = row.winner_seat === null ? null : ((row.winner_seat === 0 ? 0 : 1) as Seat);
		return {
			v: REPLAY_FORMAT_VERSION,
			matchId: row.match_id,
			mode: row.mode,
			ruleVersion: row.rule_version,
			mapVersion: row.map_version,
			seed: row.seed,
			firstSeat: state.firstSeat,
			startedAt: row.started_at,
			endedAt: row.ended_at,
			winnerSeat,
			endReason: row.end_reason,
			score: [state.score[0], state.score[1]],
			roundCount: state.round,
			seats: this.readSeats().map((seat) => ({
				seat: seat.seat,
				userId: seat.user_id,
				result: resultFor(seat.seat, winnerSeat)
			}))
		};
	}

	// ── 補助関数 ────────────────────────────────────────────────────────

	private readMatchState(): MatchStateRow | undefined {
		return this.ctx.storage.sql
			.exec<MatchStateRow>(`SELECT * FROM match_state WHERE id = 1`)
			.toArray()[0];
	}

	private scheduleNextAlarm(deadline: number | null): void {
		if (deadline === null) return;
		this.ctx.storage.setAlarm(deadline);
	}

	private send(ws: WebSocket, envelope: WsEnvelope): void {
		try {
			ws.send(JSON.stringify(envelope));
		} catch (error) {
			console.error('MatchRoom send failed', error);
		}
	}

	private broadcastExcept(excludeSeat: Seat, envelope: WsEnvelope): void {
		for (const ws of this.ctx.getWebSockets()) {
			const attachment = ws.deserializeAttachment() as ConnectionAttachment;
			if (!attachment.authenticated || attachment.seat === null) continue;
			if (attachment.seat === excludeSeat) continue;
			this.sendProjected(ws, attachment.seat, envelope);
		}
	}

	private broadcastAll(envelope: WsEnvelope): void {
		for (const ws of this.ctx.getWebSockets()) {
			const attachment = ws.deserializeAttachment() as ConnectionAttachment;
			if (!attachment.authenticated || attachment.seat === null) continue;
			this.sendProjected(ws, attachment.seat, envelope);
		}
	}

	/**
	 * `welcome`/`finished` に含まれる `view`/`summary` は座席ごとに射影し直す。
	 * `actionResult`/`events`/`opponent`/`error` は Event 自体が秘匿情報を含まないため
	 * そのまま送る（doc/designs/06-rule-engine.md 6節の根拠を参照）。
	 */
	private sendProjected(ws: WebSocket, seat: Seat, envelope: WsEnvelope): void {
		if (envelope.t === 'welcome') {
			this.send(ws, { ...envelope, seat, view: projectState(envelope.view, seat) });
			return;
		}
		if (envelope.t === 'finished') {
			this.send(ws, { ...envelope, summary: projectState(envelope.summary, seat) });
			return;
		}
		this.send(ws, envelope);
	}

	private registerInvalid(ws: WebSocket, attachment: ConnectionAttachment): void {
		const count = (this.invalidStreaks.get(attachment.connId) ?? 0) + 1;
		this.invalidStreaks.set(attachment.connId, count);
		this.send(ws, { t: 'error', code: 'E_MALFORMED', message: '不正なメッセージです' });
		if (count >= MAX_CONSECUTIVE_INVALID) {
			// TODO(フェーズ5+6): security_event へ記録する（doc/designs/14-observability.md）。
			console.error('MatchRoom: too many invalid messages, closing', attachment.connId);
			ws.close(1008, 'too many invalid messages');
		}
	}

	private checkRate(connId: string): boolean {
		const now = Date.now();
		const windowStart = now - RATE_LIMIT_WINDOW_MS;
		const timestamps = (this.messageTimestamps.get(connId) ?? []).filter((ts) => ts > windowStart);
		timestamps.push(now);
		this.messageTimestamps.set(connId, timestamps);
		return timestamps.length <= RATE_LIMIT_MESSAGES;
	}
}

// ── モジュールレベルの純粋ヘルパー ───────────────────────────────────────

type DispatchResult =
	{ ok: true; value: StateChange } | { ok: false; error: string; errorCode: ErrorCode };

/**
 * WS の Command を対応するエンジン関数へ振り分ける。
 * ここが実質的な `applyCommand` ディスパッチャである（このファイル冒頭のコメント参照）。
 */
function dispatchCommand(state: GameState, seat: Seat, command: Command): DispatchResult {
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

function groupIntoBatches(
	rows: { rev: number; event_seq: number; event_json: string }[],
	actorBySeatRev: Map<number, number | null>
): EventBatch[] {
	const byRev = new Map<number, GameEvent[]>();
	for (const row of rows) {
		const list = byRev.get(row.rev) ?? [];
		list[row.event_seq] = JSON.parse(row.event_json) as GameEvent;
		byRev.set(row.rev, list);
	}
	return [...byRev.entries()]
		.sort(([a], [b]) => a - b)
		.map(([rev, events]) => ({ rev, actorSeat: actorBySeatRev.get(rev) ?? null, events }));
}

/** 座席から見た勝敗。引き分けと無効試合は `draw` として扱う。 */
function resultFor(seat: Seat, winnerSeat: Seat | null): string {
	if (winnerSeat === null) return 'draw';
	return winnerSeat === seat ? 'win' : 'loss';
}

function seatValue(winner: GameState['winner']): Seat | null {
	return winner === 'draw' || winner === null ? null : winner;
}

function randomSeedHex(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
