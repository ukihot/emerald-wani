// 対戦を実際に駆動するための共通クライアント。
//
// verify-phase5 / load-test の**両方がこの1本を使う**。ゲスト発行 → マッチング →
// WS チケット → hello → Command 送信という手順はサーバ側の契約そのもので、
// 検証スクリプトごとに写しを持つと、片方だけが古い契約のまま通ってしまう。
//
// 布陣座標の根拠は doc/board.md 4節（固定ゾーン）。

export const webOrigin = process.env.EMERALD_WEB_ORIGIN ?? 'http://localhost:5173';
export const realtimeOrigin = process.env.EMERALD_REALTIME_ORIGIN ?? 'http://127.0.0.1:8787';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function assert(condition, message) {
	if (!condition) throw new Error(message);
}

export async function expectOk(response, label) {
	if (!response.ok) {
		const body = await response.text().catch(() => '<unreadable>');
		throw new Error(`${label}: HTTP ${response.status} ${body}`);
	}
	return response;
}

export const KINDS = ['nushi', 'katsugi', 'pocha', 'biyoon', 'naname', 'sekkachi', 'tobi', 'kowa'];
export const SOUTH_CELLS = ['3:7', '2:7', '4:7', '1:7', '5:7', '0:7', '6:7', '2:8'];
export const NORTH_CELLS = ['3:1', '2:1', '4:1', '1:1', '5:1', '0:1', '6:1', '2:0'];

export function placementsFor(seat) {
	const cells = seat === 0 ? SOUTH_CELLS : NORTH_CELLS;
	return KINDS.map((kind, index) => ({ kind, cellId: cells[index] }));
}

/** 応答の Set-Cookie からセッション Cookie を取り出す。 */
export function sessionCookieFrom(response) {
	const raw = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie')];
	const entries = raw.filter(Boolean).map((value) => value.split(';', 1)[0]);
	const session = entries.find((entry) => entry.includes('session_token'));
	return session ?? entries[0] ?? null;
}

export async function signInGuest(name) {
	const response = await expectOk(
		await fetch(`${webOrigin}/api/auth/sign-in/anonymous`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}'
		}),
		`${name} guest sign-in`
	);
	const body = await response.json();
	const cookie = sessionCookieFrom(response);
	assert(cookie, `${name}: no session cookie issued`);
	assert(body.user?.isAnonymous === true, `${name}: not an anonymous user`);
	return { cookie, userId: body.user.id, displayName: body.user.name };
}

export async function enqueue(name, cookie) {
	await expectOk(
		await fetch(`${webOrigin}/api/v1/matchmaking/enqueue`, {
			method: 'POST',
			headers: { cookie, 'content-type': 'application/json' },
			body: JSON.stringify({ requestId: crypto.randomUUID() })
		}),
		`${name} enqueue`
	);
}

export async function pollUntilMatched(name, cookie, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const response = await expectOk(
			await fetch(`${webOrigin}/api/v1/matchmaking/status`, { headers: { cookie } }),
			`${name} status`
		);
		const body = await response.json();
		if (body.status === 'matched') return body.matchId;
		await sleep(500);
	}
	throw new Error(`${name}: not matched within ${timeoutMs}ms`);
}

export async function fetchTicket(name, cookie, matchId) {
	const response = await expectOk(
		await fetch(`${webOrigin}/api/v1/matches/${matchId}/ws-ticket`, {
			method: 'POST',
			headers: { cookie }
		}),
		`${name} ws-ticket`
	);
	return (await response.json()).ticket;
}

/**
 * WS プレイヤー。
 *
 * verify-phase4.mjs の実装との違いは**受信箱を持つ**こと。サーバは相手の行動を
 * こちらの `await` とは無関係に送ってくるため、「待ち始める前に届いた `events`」を
 * 取りこぼすと `rev` が古いまま次の Command を送り、E_STALE_REV で弾かれる。
 * 受信済みのフレームを貯めておき、`waitFor` はまず受信箱から取る。
 */
export class Player {
	constructor(name, matchId, ticket) {
		this.name = name;
		this.matchId = matchId;
		this.ticket = ticket;
		/** 未消費の受信フレーム。 */
		this.inbox = [];
		/** `{ types, resolve }` の配列。先に登録したものから消費する。 */
		this.waiters = [];
		this.seat = null;
		this.rev = 0;
	}

	/**
	 * `lastRev` を渡すと再接続として扱われ、DO は差分から再送する。
	 * `ip` は WS Upgrade の粗いレート制限（30/60秒、IP単位）を実クライアントのように
	 * 散らすためのもの。負荷試験で1IPに潰れると、測りたい対戦の負荷ではなく
	 * 入口の制限を測ってしまう。
	 */
	async connect({ lastRev, ip } = {}) {
		const url = `${realtimeOrigin.replace('http', 'ws')}/ws/matches/${this.matchId}`;
		const headers = { Origin: webOrigin, ...(ip ? { 'cf-connecting-ip': ip } : {}) };
		this.socket = new WebSocket(url, { headers });
		await new Promise((resolve, reject) => {
			this.socket.addEventListener('open', () => resolve());
			this.socket.addEventListener('error', (event) => reject(event));
		});
		this.socket.addEventListener('message', (event) => {
			const message = JSON.parse(String(event.data));
			if (typeof message.toRev === 'number') this.rev = message.toRev;
			const index = this.waiters.findIndex((waiter) => waiter.types.includes(message.t));
			if (index < 0) {
				this.inbox.push(message);
				return;
			}
			const [waiter] = this.waiters.splice(index, 1);
			waiter.resolve(message);
		});
		this.socket.send(
			JSON.stringify({
				t: 'hello',
				ticket: this.ticket,
				...(lastRev === undefined ? {} : { lastRev })
			})
		);
		const welcome = await this.waitFor('welcome');
		this.seat = welcome.seat;
		this.rev = welcome.rev;
		return welcome;
	}

	/** 指定した `t` のフレームを1件消費する。複数指定すると最初に届いたものを返す。 */
	waitFor(types, timeoutMs = 10_000) {
		const wanted = Array.isArray(types) ? types : [types];
		const buffered = this.inbox.findIndex((message) => wanted.includes(message.t));
		if (buffered >= 0) return Promise.resolve(this.inbox.splice(buffered, 1)[0]);

		return new Promise((resolve, reject) => {
			const entry = {
				types: wanted,
				resolve: (message) => {
					clearTimeout(timer);
					resolve(message);
				}
			};
			const timer = setTimeout(() => {
				this.waiters = this.waiters.filter((waiter) => waiter !== entry);
				reject(new Error(`${this.name}: timed out waiting for "${wanted.join('|')}"`));
			}, timeoutMs);
			this.waiters.push(entry);
		});
	}

	/**
	 * 1件の Command を送り、確定結果を待つ。
	 *
	 * サーバは拒否時に `actionResult` ではなく `error` を返すため、両方を待って
	 * 失敗をタイムアウトではなくエラーとして表面化させる。
	 */
	async act(action) {
		const actionId = crypto.randomUUID();
		this.socket.send(JSON.stringify({ t: 'act', actionId, baseRev: this.rev, action }));
		const result = await this.waitFor(['actionResult', 'error']);
		if (result.t === 'error') {
			throw new Error(`${this.name}: action rejected (${result.code}: ${result.message})`);
		}
		return result;
	}

	/** 拒否されることを承知で送る。例外にせず、届いたフレームをそのまま返す。 */
	async actRaw(action, timeoutMs = 10_000) {
		const actionId = crypto.randomUUID();
		this.socket.send(JSON.stringify({ t: 'act', actionId, baseRev: this.rev, action }));
		return this.waitFor(['actionResult', 'error'], timeoutMs);
	}

	/** スキーマ違反のフレームを素で送る（DO の E_MALFORMED 経路を突く）。 */
	sendMalformed() {
		this.socket.send(JSON.stringify({ t: 'act', actionId: 1, baseRev: 'x' }));
	}

	/** サーバから切断されるまで待つ（無効操作の連発で閉じられることの確認に使う）。 */
	waitForClose(timeoutMs = 10_000) {
		if (!this.socket || this.socket.readyState === 3) return Promise.resolve(true);
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve(false), timeoutMs);
			this.socket.addEventListener('close', () => {
				clearTimeout(timer);
				resolve(true);
			});
		});
	}

	close() {
		this.socket?.close();
	}
}
