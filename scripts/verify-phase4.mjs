// フェーズ4のスモークテスト。実際に立ち上がった web / realtime に対して
// 2人のゲストで matchmaking → WS 接続 → 布陣 → 対局 → 投了/finished、
// さらに再接続とターン時間切れまでを一気通貫で検証する。
// pnpm dev を別途起動してから `node scripts/verify-phase4.mjs` を実行する。
//
// 布陣座標は doc/board.md 4節「自動配置」の固定ゾーン順序をそのまま使う。
// 固定ゾーン（南 y=7,8 / 北 y=0,1）はニュートラルゾーン生成の対象外
// （盤面・初期化仕様 v1 の 1節）のため、どの seed でも常に通常マスであり、
// ルールエンジンを import せずハードコードしてよい。

const webOrigin = process.env.EMERALD_WEB_ORIGIN ?? 'http://localhost:5173';
const realtimeOrigin = process.env.EMERALD_REALTIME_ORIGIN ?? 'http://127.0.0.1:8787';
const SKIP_TIMEOUT_CHECK = process.env.SKIP_TIMEOUT_CHECK === '1';

const KINDS = ['nushi', 'katsugi', 'pocha', 'biyoon', 'naname', 'sekkachi', 'tobi', 'kowa'];
const SOUTH_CELLS = ['3:7', '2:7', '4:7', '1:7', '5:7', '0:7', '6:7', '2:8'];
const NORTH_CELLS = ['3:1', '2:1', '4:1', '1:1', '5:1', '0:1', '6:1', '2:0'];

function placementsFor(seat) {
	const cells = seat === 0 ? SOUTH_CELLS : NORTH_CELLS;
	return KINDS.map((kind, index) => ({ kind, cellId: cells[index] }));
}

function log(label, ...rest) {
	console.log(`[verify-phase4] ${label}`, ...rest);
}

async function expectOk(response, label) {
	if (!response.ok) {
		const body = await response.text().catch(() => '<unreadable>');
		throw new Error(`${label}: HTTP ${response.status} ${body}`);
	}
	return response;
}

/** ゲストとしてサインインし、Cookie とユーザーIDを返す。 */
async function signInGuest(name) {
	const response = await expectOk(
		await fetch(`${webOrigin}/api/auth/sign-in/anonymous`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}'
		}),
		`${name} guest sign-in`
	);
	const body = await response.json();
	const setCookie = response.headers.get('set-cookie');
	const cookie = setCookie?.split(';', 1)[0];
	if (!cookie) throw new Error(`${name}: no session cookie issued`);
	if (body.user?.isAnonymous !== true) throw new Error(`${name}: not an anonymous user`);
	log(`${name} signed in`, { userId: body.user.id });
	return { cookie, userId: body.user.id };
}

async function enqueue(name, cookie) {
	await expectOk(
		await fetch(`${webOrigin}/api/v1/matchmaking/enqueue`, {
			method: 'POST',
			headers: { cookie, 'content-type': 'application/json' },
			body: JSON.stringify({ requestId: crypto.randomUUID() })
		}),
		`${name} enqueue`
	);
}

async function pollUntilMatched(name, cookie, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const response = await expectOk(
			await fetch(`${webOrigin}/api/v1/matchmaking/status`, { headers: { cookie } }),
			`${name} status`
		);
		const body = await response.json();
		if (body.status === 'matched') {
			log(`${name} matched`, { matchId: body.matchId });
			return body.matchId;
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`${name}: not matched within ${timeoutMs}ms`);
}

async function fetchTicket(name, cookie, matchId) {
	const response = await expectOk(
		await fetch(`${webOrigin}/api/v1/matches/${matchId}/ws-ticket`, {
			method: 'POST',
			headers: { cookie }
		}),
		`${name} ws-ticket`
	);
	const body = await response.json();
	return body.ticket;
}

/** 単純な WS プレイヤー。受信メッセージを t ごとに待てるようにしておく。 */
class Player {
	constructor(name, matchId, ticket) {
		this.name = name;
		this.matchId = matchId;
		this.ticket = ticket;
		this.waiters = new Map();
		this.messages = [];
		this.seat = null;
		this.rev = 0;
	}

	async connect(lastRev) {
		const url = `${realtimeOrigin.replace('http', 'ws')}/ws/matches/${this.matchId}`;
		this.socket = new WebSocket(url, { headers: { Origin: webOrigin } });
		await new Promise((resolve, reject) => {
			this.socket.addEventListener('open', () => resolve());
			this.socket.addEventListener('error', (event) => reject(event));
			this.socket.addEventListener('close', (event) =>
				reject(new Error(`closed before open: code=${event.code} reason=${event.reason}`))
			);
		});
		this.socket.addEventListener('message', (event) => this.onMessage(String(event.data)));
		this.socket.addEventListener('close', (event) => {
			if (process.env.DEBUG_WS) {
				console.log(`[debug] ${this.name} socket closed`, event.code, event.reason);
			}
		});
		this.socket.send(JSON.stringify({ t: 'hello', ticket: this.ticket, lastRev }));
		const welcome = await this.waitFor('welcome');
		this.seat = welcome.seat;
		this.rev = welcome.rev;
		return welcome;
	}

	onMessage(raw) {
		if (process.env.DEBUG_WS) console.log(`[debug] ${this.name} <-`, raw);
		const message = JSON.parse(raw);
		this.messages.push(message);
		if (typeof message.toRev === 'number') this.rev = message.toRev;
		const waiter = this.waiters.get(message.t);
		if (waiter) {
			this.waiters.delete(message.t);
			waiter(message);
		}
	}

	waitFor(type, timeoutMs = 10_000) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`${this.name}: timed out waiting for "${type}"`)),
				timeoutMs
			);
			this.waiters.set(type, (message) => {
				clearTimeout(timer);
				resolve(message);
			});
		});
	}

	async act(action) {
		const actionId = crypto.randomUUID();
		this.socket.send(JSON.stringify({ t: 'act', actionId, baseRev: this.rev, action }));
		const result = await this.waitFor('actionResult');
		if (result.actionId !== actionId) throw new Error(`${this.name}: actionId mismatch`);
		return result;
	}

	close(code = 1000) {
		this.socket.close(code);
	}
}

async function main() {
	await expectOk(await fetch(`${realtimeOrigin}/health`), 'realtime health');
	await expectOk(await fetch(webOrigin), 'web root');

	const alice = await signInGuest('alice');
	const bob = await signInGuest('bob');

	await enqueue('alice', alice.cookie);
	await enqueue('bob', bob.cookie);
	const [matchIdA, matchIdB] = await Promise.all([
		pollUntilMatched('alice', alice.cookie),
		pollUntilMatched('bob', bob.cookie)
	]);
	if (matchIdA !== matchIdB) throw new Error('alice/bob were matched into different matches');
	const matchId = matchIdA;

	const ticketA = await fetchTicket('alice', alice.cookie, matchId);
	const ticketB = await fetchTicket('bob', bob.cookie, matchId);

	const playerA = new Player('alice', matchId, ticketA);
	const playerB = new Player('bob', matchId, ticketB);
	const welcomeA = await playerA.connect();
	const welcomeB = await playerB.connect();
	if (welcomeA.seat === welcomeB.seat) throw new Error('both players got the same seat');
	log('seats assigned', { alice: welcomeA.seat, bob: welcomeB.seat });

	// 布陣中は相手の配置が一切含まれないことを確認する（P-5 秘匿性）。
	for (const view of [welcomeA.view, welcomeB.view]) {
		const leaked = Object.values(view.pieces).some(
			(piece) =>
				piece.owner !== (view === welcomeA.view ? welcomeA.seat : welcomeB.seat) && piece.position
		);
		if (leaked) throw new Error('opponent deployment leaked before reveal');
	}

	const seatToPlayer = { [welcomeA.seat]: playerA, [welcomeB.seat]: playerB };
	const first = seatToPlayer[0];
	const second = seatToPlayer[1];

	const firstDeployResult = await first.act({
		type: 'submitDeployment',
		placements: placementsFor(0)
	});
	log('seat0 deployed', { toRev: firstDeployResult.toRev });
	const revealForSecond = await second.waitFor('events');
	log('seat1 saw seat0 deployment event', {
		messages: revealForSecond.events.flatMap((batch) => batch.events.map((event) => event.message))
	});

	// 実質的な秘匿性の検証: 片方だけ確定した直後に seat1 が resync した射影に、
	// seat0 の駒位置が一切含まれないことを確認する（P-5 秘匿性の本題）。
	const midDeploymentWelcome = second.waitFor('welcome');
	second.socket.send(JSON.stringify({ t: 'resync' }));
	const midView = (await midDeploymentWelcome).view;
	const leakedAfterPartialDeployment = Object.values(midView.pieces).some(
		(piece) => piece.owner !== second.seat && piece.position !== null
	);
	if (leakedAfterPartialDeployment) {
		throw new Error('opponent deployment leaked to the not-yet-confirmed player');
	}
	log('confirmed: seat0 deployment not visible to seat1 before seat1 also confirms');

	const secondDeployResult = await second.act({
		type: 'submitDeployment',
		placements: placementsFor(1)
	});
	const revealMessages = secondDeployResult.events.flatMap((batch) =>
		batch.events.map((event) => event.message)
	);
	if (!revealMessages.some((message) => message.includes('公開'))) {
		throw new Error('reveal event missing after both deployments confirmed');
	}
	log('both deployed, board revealed');

	// 再接続の検証: 非アクティブ（座席1）側の接続を意図的に落とし、lastRev 付きで復帰する。
	// rules-1.0.0 では常に座席0が先手のため、座席1は非アクティブ側で固定できる。
	const passive = seatToPlayer[1];
	const passiveName = passive === playerA ? 'alice' : 'bob';
	const passiveCookie = passiveName === 'alice' ? alice.cookie : bob.cookie;
	const revBeforeDisconnect = passive.rev;
	passive.close(1000);
	await new Promise((resolve) => setTimeout(resolve, 300));
	const reconnected = new Player(
		passiveName,
		matchId,
		await fetchTicket(passiveName, passiveCookie, matchId)
	);
	const resumedWelcome = await reconnected.connect(revBeforeDisconnect);
	if (resumedWelcome.rev < revBeforeDisconnect) {
		throw new Error('reconnect returned an older rev than before disconnect');
	}
	log('reconnect ok', { rev: resumedWelcome.rev });
	// 以後はこの新しい接続を座席1の代表として扱う（元の playerA/playerB のうち
	// どちらか一方のソケットは close 済みのため参照しない）。
	seatToPlayer[1] = reconnected;

	if (!SKIP_TIMEOUT_CHECK) {
		// ターン時間切れの検証（実時間で約30秒待つ）。非アクティブ側は何もせず、
		// サーバの alarm が自動で endTurn(timedOut=true) を発行することを確認する。
		log('waiting ~30s to verify the server-side turn timeout alarm...');
		const timeoutEvents = await seatToPlayer[1].waitFor('events', 35_000);
		const messages = timeoutEvents.events.flatMap((batch) => batch.events.map((e) => e.message));
		if (!messages.some((message) => message.includes('時間切れ'))) {
			throw new Error(`expected a timeout event, got: ${JSON.stringify(messages)}`);
		}
		log('turn timeout fired automatically as expected', { messages });
	} else {
		log('SKIP_TIMEOUT_CHECK=1: skipping the ~30s timeout wait');
	}

	// 投了で終局まで一気に進める。rules-1.0.0 の先手は常に座席0
	// （doc/board.md 3節）。タイムアウト検証を実行した場合はちょうど1回
	// sys.turnTimeout が発生しているため、手番は座席1へ移っている。
	const activeSeat = SKIP_TIMEOUT_CHECK ? 0 : 1;
	const finishedWaiters = [
		seatToPlayer[0].waitFor('finished'),
		seatToPlayer[1].waitFor('finished')
	];
	await seatToPlayer[activeSeat].act({ type: 'concede' });
	const [finished0, finished1] = await Promise.all(finishedWaiters);
	const expectedWinner = activeSeat === 0 ? 1 : 0;
	if (finished0.winnerSeat !== expectedWinner || finished1.winnerSeat !== expectedWinner) {
		throw new Error(
			`expected seat${expectedWinner} to win by concede, got ${JSON.stringify({ finished0, finished1 })}`
		);
	}
	log('match finished by concede as expected', { winnerSeat: finished0.winnerSeat });

	seatToPlayer[0].close();
	seatToPlayer[1].close();

	console.log('\n[verify-phase4] ALL CHECKS PASSED ✅');
}

main().catch((error) => {
	console.error('[verify-phase4] FAILED:', error);
	process.exitCode = 1;
});
