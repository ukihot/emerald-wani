import { SvelteMap } from 'svelte/reactivity';
import type { GameState } from '$lib/game';
import type { ErrorCode } from '$lib/protocol/ws';

/**
 * オンライン対戦用の WebSocket クライアント。
 *
 * 設計: doc/designs/09-api-protocol.md 2節。
 *   - 接続確立後、最初のフレームで `hello`（チケット）を送る。URLには載せない。
 *   - `actionId` はクライアントが採番し、`baseRev` を添えて送る。
 *   - サーバの `events`/`actionResult` を正として、ローカルの暫定状態は持たない
 *     （doc/designs/06-rule-engine.md 10節: 正の判定は常にサーバの `applyCommand`）。
 *
 * Svelte 5 の runes を使った素朴なリアクティブクラス。コンポーネントから
 * `new WsClient()` して直接 `.view` 等を参照できる。
 */

type EventBatch = {
	rev: number;
	actorSeat: number | null;
	events: { type: string; message: string }[];
};

interface Deadlines {
	deploymentEndsAt: number | null;
	turnEndsAt: number | null;
}

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

const RECONNECTABLE_CODES = new Set([1000, 1001, 1006, 1011, 1012, 1013, 4008]);
const MAX_RECONNECT_DELAY_MS = 30_000;

export class WsClient {
	status = $state<ConnectionStatus>('idle');
	seat = $state<0 | 1 | null>(null);
	rev = $state<number>(0);
	view = $state<GameState | null>(null);
	deadlines = $state<Deadlines>({ deploymentEndsAt: null, turnEndsAt: null });
	opponentConnected = $state<boolean>(true);
	log = $state<string[]>([]);
	lastError = $state<{ code: ErrorCode; message: string } | null>(null);
	finished = $state<{ winnerSeat: 0 | 1 | null; endReason: string | null } | null>(null);

	private matchId: string | null = null;
	private getTicket: (() => Promise<string>) | null = null;
	private socket: WebSocket | null = null;
	private reconnectAttempts = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private closedByUser = false;
	private pendingActions = new SvelteMap<
		string,
		{ resolve: () => void; reject: (error: Error) => void }
	>();

	async connect(matchId: string, getTicket: () => Promise<string>): Promise<void> {
		this.matchId = matchId;
		this.getTicket = getTicket;
		this.closedByUser = false;
		this.reconnectAttempts = 0;
		await this.open();
	}

	disconnect(): void {
		this.closedByUser = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.socket?.close(1000, 'client disconnect');
		this.socket = null;
		this.status = 'closed';
	}

	/** 行動を送信する。サーバの `actionResult` が届くと解決する。 */
	sendAction(action: Record<string, unknown>): Promise<void> {
		if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error('接続していません'));
		}
		const actionId = crypto.randomUUID();
		const message = { t: 'act', actionId, baseRev: this.rev, action };
		return new Promise((resolve, reject) => {
			this.pendingActions.set(actionId, { resolve, reject });
			this.socket!.send(JSON.stringify(message));
		});
	}

	resync(): void {
		this.socket?.send(JSON.stringify({ t: 'resync' }));
	}

	private async open(): Promise<void> {
		if (!this.matchId || !this.getTicket) return;
		this.status = this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting';

		let ticket: string;
		try {
			ticket = await this.getTicket();
		} catch {
			this.pushLog('チケットの取得に失敗しました');
			this.scheduleReconnect();
			return;
		}

		const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const url = `${wsProtocol}//${location.host}/ws/matches/${this.matchId}`;
		const socket = new WebSocket(url);
		this.socket = socket;

		socket.addEventListener('open', () => {
			const lastRev = this.rev > 0 ? this.rev : undefined;
			socket.send(JSON.stringify({ t: 'hello', ticket, lastRev }));
		});

		socket.addEventListener('message', (event) => {
			this.handleMessage(String(event.data));
		});

		socket.addEventListener('close', (event) => {
			this.socket = null;
			if (this.closedByUser) {
				this.status = 'closed';
				return;
			}
			this.pushLog(`接続が切断されました (${event.code})`);
			if (RECONNECTABLE_CODES.has(event.code)) {
				this.scheduleReconnect();
			} else {
				this.status = 'closed';
			}
		});

		socket.addEventListener('error', () => {
			// close ハンドラ側で再接続を判断するため、ここでは何もしない。
		});
	}

	private scheduleReconnect(): void {
		if (this.closedByUser) return;
		this.status = 'reconnecting';
		const delay = Math.min(1000 * 2 ** this.reconnectAttempts, MAX_RECONNECT_DELAY_MS);
		this.reconnectAttempts += 1;
		this.reconnectTimer = setTimeout(() => {
			void this.open();
		}, delay);
	}

	private handleMessage(raw: string): void {
		let message: Record<string, unknown>;
		try {
			message = JSON.parse(raw);
		} catch {
			return;
		}

		switch (message.t) {
			case 'welcome': {
				this.status = 'open';
				this.reconnectAttempts = 0;
				this.seat = message.seat as 0 | 1;
				this.rev = message.rev as number;
				this.view = message.view as GameState;
				this.deadlines = message.deadlines as Deadlines;
				this.pushLog('サーバへ接続しました');
				break;
			}
			case 'actionResult': {
				this.applyEventBatches(message.toRev as number, message.events as EventBatch[]);
				const pending = this.pendingActions.get(message.actionId as string);
				if (pending) {
					pending.resolve();
					this.pendingActions.delete(message.actionId as string);
				}
				break;
			}
			case 'events': {
				this.applyEventBatches(message.toRev as number, message.events as EventBatch[]);
				break;
			}
			case 'error': {
				const code = message.code as ErrorCode;
				const text = message.message as string;
				this.lastError = { code, message: text };
				this.pushLog(`エラー: ${text}`);
				const actionId = message.actionId as string | undefined;
				if (actionId) {
					const pending = this.pendingActions.get(actionId);
					if (pending) {
						pending.reject(new Error(text));
						this.pendingActions.delete(actionId);
					}
				}
				break;
			}
			case 'opponent': {
				this.opponentConnected = message.status === 'connected';
				this.pushLog(this.opponentConnected ? '相手が接続しました' : '相手が切断しました');
				break;
			}
			case 'finished': {
				this.view = message.summary as GameState;
				this.finished = {
					winnerSeat: message.winnerSeat as 0 | 1 | null,
					endReason: message.endReason as string | null
				};
				this.pushLog('対局が終了しました');
				break;
			}
		}
	}

	/**
	 * サーバから届いた `EventBatch[]` を `view` へ反映する。
	 * このクライアントはローカルでルール判定を行わない
	 * （`predictView` 相当の予告演出は今回のスコープ外。常にサーバ確定状態のみを表示する）。
	 */
	private applyEventBatches(toRev: number, batches: EventBatch[]): void {
		this.rev = toRev;
		for (const batch of batches) {
			for (const event of batch.events) this.pushLog(event.message);
		}
		// `EventBatch` はログ表示用の差分（メッセージ文字列）だけを運び、盤面そのものは
		// 含まない。クライアント側に差分適用ロジック（サーバの reducer の複製）を持たせず、
		// 常にサーバへ `resync` して完全な射影済み状態を取り直す設計にしている
		// （doc/designs/06-rule-engine.md 10節: 正の判定は常にサーバの `applyCommand`）。
		// 通信は1手あたり1往復分増えるが、盤面のズレが原理的に発生しないという利点を優先した。
		this.resync();
	}

	private pushLog(message: string): void {
		this.log = [message, ...this.log].slice(0, 20);
	}
}
