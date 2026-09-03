/**
 * emerald-wani-realtime — WebSocket の入口。
 *
 * このワーカーが検証するのは Origin / Upgrade / パス形式 / 粗いレート制限だけである。
 * **チケットの署名・有効期限・座席は一切検証しない。** それらは MatchRoom DO 自身が
 * `hello` フレームで検証する（doc/designs/02-architecture.md 3.5、D-24）。
 *
 * 理由: Hibernation API の標準フローでは入口ワーカーが `stub.fetch(request)` を呼び、
 * DO が接続を受理して以後のフレームを受け取る。入口ワーカーが先にフレームを読むと
 * 同じ接続を DO へ移管できず、ワーカーを常駐リレーにする必要が生じる。
 */

export { MatchRoom } from './match-room';
export { MatchQueue } from './match-queue';
export { GuestIssuanceGuard } from './guest-issuance-guard';

/** `/ws/matches/{matchId}` の matchId を取り出す。形式不正なら null。 */
function parseMatchPath(pathname: string): string | null {
	const match = /^\/ws\/matches\/([0-9a-fA-F-]{36})$/.exec(pathname);
	return match ? match[1] : null;
}

function isAllowedOrigin(origin: string | null, allowList: string): boolean {
	if (!origin) return false;
	const allowed = allowList
		.split(',')
		.map((o) => o.trim())
		.filter(Boolean);
	return allowed.includes(origin);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/health') {
			return Response.json({ ok: true, worker: 'emerald-wani-realtime' });
		}

		const matchId = parseMatchPath(url.pathname);
		if (!matchId) {
			return new Response('Not Found', { status: 404 });
		}

		// Origin 検証（doc/designs/11-security-controls.md 11.2）
		if (!isAllowedOrigin(request.headers.get('Origin'), env.ALLOWED_WS_ORIGINS)) {
			return new Response('Forbidden', { status: 403 });
		}

		// Upgrade 検証
		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('Expected websocket', { status: 426 });
		}

		// TODO(フェーズ5): IP 単位の粗いレート制限を ratelimit バインディングで追加する
		// （doc/designs/11-security-controls.md 11.4）。チケットの正当性はここでは見ない。

		// 未検証のまま DO へ転送する。認証は DO 側の `hello` で行う。
		const stub = env.MATCH_ROOM.get(env.MATCH_ROOM.idFromName(matchId));
		return stub.fetch(request);
	}
} satisfies ExportedHandler<Env>;
