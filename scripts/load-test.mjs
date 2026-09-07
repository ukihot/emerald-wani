// 公開前の負荷・耐性試験（doc/designs/19-testing.md 5節、フェーズ7）。
//
//   pnpm dev                # 別ターミナルで起動しておく
//   pnpm load-test          # 既定 8 対戦（16接続）
//   EMERALD_PAIRS=16 EMERALD_TURNS=10 pnpm load-test
//
// 測る対象（測定値と判定基準は doc/load-test.md）:
//   1. 同時対戦        … ゲスト発行 → マッチング → WS 接続 → 布陣 → ターン進行
//   2. 再接続集中      … 全接続を同時に落とし、チケット再取得 + lastRev で一斉復帰
//   3. 大量の無効操作  … 連続無効の閾値で DO が切断すること（拒否で対戦が壊れないこと）
//   4. ログ書き出し    … 終局 → Queue → consumer → D1/R2 のアーカイブ所要時間
//
// **測るのは経路の耐性であって、ルールエンジンの計算量ではない。** ターン進行には
// endTurn を使う。合法手の生成にはエンジン本体が要り、負荷試験スクリプトから
// 呼ぶと検証対象の二重実装になる（エンジン単体の負荷は Vitest 側で見る）。

import {
	Player,
	assert,
	enqueue,
	fetchTicket,
	placementsFor,
	pollUntilMatched,
	realtimeOrigin,
	signInGuest,
	sleep,
	webOrigin
} from './match-client.mjs';

const pairs = Number(process.env.EMERALD_PAIRS ?? 8);
const turns = Number(process.env.EMERALD_TURNS ?? 6);

function log(label, ...rest) {
	console.log(`[load-test] ${label}`, ...rest);
}

/** 実クライアントのように接続元を散らす（match-client.mjs の connect 参照）。 */
const ipFor = (index) => `203.0.113.${(index % 250) + 1}`;

async function timed(samples, fn) {
	const started = performance.now();
	const value = await fn();
	samples.push(performance.now() - started);
	return value;
}

function stats(samples) {
	if (samples.length === 0) return null;
	const sorted = [...samples].sort((left, right) => left - right);
	const at = (ratio) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
	const round = (value) => Math.round(value * 10) / 10;
	return { n: sorted.length, p50: round(at(0.5)), p95: round(at(0.95)), max: round(sorted.at(-1)) };
}

const metrics = {
	guest: [],
	matchmaking: [],
	ticket: [],
	connect: [],
	deployment: [],
	command: [],
	rejection: [],
	reconnect: [],
	archive: [],
	archiveFallback: []
};
const errors = [];

/**
 * 2N 人のゲストを一度にキューへ入れ、**サーバが組んだ相手**で対戦を作る。
 *
 * 「a と b が組む」と決め打ちしないこと。実際の MatchQueue は先着順に組むため、
 * 決め打ちすると同時実行時に必ず食い違う（=負荷ではなく前提の誤りで落ちる）。
 */
async function formMatches() {
	const guests = await Promise.all(
		Array.from({ length: pairs * 2 }, (_, index) =>
			timed(metrics.guest, () => signInGuest(`guest${index}`))
		)
	);

	const matched = await timed(metrics.matchmaking, async () => {
		await Promise.all(guests.map((guest, index) => enqueue(`guest${index}`, guest.cookie)));
		return Promise.all(
			guests.map(async (guest, index) => ({
				guest,
				matchId: await pollUntilMatched(`guest${index}`, guest.cookie, 90_000)
			}))
		);
	});

	const byMatch = new Map();
	for (const entry of matched) {
		const group = byMatch.get(entry.matchId) ?? [];
		group.push(entry.guest);
		byMatch.set(entry.matchId, group);
	}

	const matches = [];
	for (const [matchId, members] of byMatch) {
		if (members.length !== 2) {
			errors.push(`match ${matchId}: ${members.length} player(s) instead of 2`);
			continue;
		}
		matches.push({ tag: matchId.slice(0, 8), matchId, guests: members });
	}
	return matches;
}

/** 接続 → 布陣 → ターン進行。 */
async function playMatch(match, index) {
	const seatIps = [ipFor(index * 2), ipFor(index * 2 + 1)];
	const players = [];
	for (const [offset, guest] of match.guests.entries()) {
		const ticket = await timed(metrics.ticket, () =>
			fetchTicket(`${match.tag}${offset}`, guest.cookie, match.matchId)
		);
		const player = new Player(`${match.tag}${offset}`, match.matchId, ticket);
		await timed(metrics.connect, () => player.connect({ ip: seatIps[offset] }));
		players.push(player);
	}

	const bySeat = { [players[0].seat]: players[0], [players[1].seat]: players[1] };
	Object.assign(match, { players, bySeat, seatIps });

	await timed(metrics.deployment, async () => {
		await bySeat[0].act({ type: 'submitDeployment', placements: placementsFor(0) });
		await bySeat[1].waitFor('events');
		await bySeat[1].act({ type: 'submitDeployment', placements: placementsFor(1) });
		await bySeat[0].waitFor('events');
	});

	// 交互に endTurn。1接続あたり 20件/10秒 の上限（doc/designs/11-security-controls.md 11.2）を
	// 割らないよう、1手ごとに間隔を空ける。
	for (let turn = 0; turn < turns; turn += 1) {
		const actor = bySeat[turn % 2];
		const waiter = bySeat[(turn + 1) % 2];
		await timed(metrics.command, async () => {
			await actor.act({ type: 'endTurn' });
			await waiter.waitFor('events');
		});
		await sleep(550);
	}
	return match;
}

/** 全接続を同時に落とし、チケット再取得 + lastRev で一斉に復帰させる。 */
async function reconnectStorm(matches) {
	const targets = matches.flatMap((match) =>
		match.players.map((player, offset) => ({ match, player, offset }))
	);
	for (const { player } of targets) player.close();
	await sleep(200);

	const revived = await Promise.all(
		targets.map(({ match, player, offset }) =>
			timed(metrics.reconnect, async () => {
				const ticket = await fetchTicket(player.name, match.guests[offset].cookie, match.matchId);
				const next = new Player(player.name, match.matchId, ticket);
				const welcome = await next.connect({ lastRev: player.rev, ip: match.seatIps[offset] });
				assert(welcome.rev >= player.rev, `${player.name}: rev regressed after reconnect`);
				return { match, offset, player: next };
			})
		)
	);

	for (const { match, offset, player } of revived) {
		match.players[offset] = player;
		match.bySeat[player.seat] = player;
	}
	return revived.length;
}

/**
 * 無効な操作を連発する。2種類あり、サーバの扱いも違う。
 *
 *   1. 形式は正しいが規則上できない操作 … `error` で拒否されるだけ。**切断しない**
 *      （正当なクライアントも打てない手を送りうるため）。
 *   2. スキーマ違反のフレーム … 連続5件で DO が切断する
 *      （doc/designs/11-security-controls.md 11.2 / MAX_CONSECUTIVE_INVALID）。
 */
async function invalidOperationFlood(match) {
	// 手番でない側を的にする。MatchRoom は非手番の Command を種類を問わず
	// E_NOT_YOUR_TURN で弾くため、手番側を切断すると投了できなくなる。
	const victim = match.bySeat[(turns + 1) % 2];
	let rejected = 0;
	for (let attempt = 0; attempt < 8; attempt += 1) {
		const frame = await timed(metrics.rejection, () =>
			victim.actRaw({ type: 'move', pieceId: '0:nushi', toCellId: '0:0' }, 5_000)
		);
		if (frame.t === 'error') rejected += 1;
	}
	const survivedIllegal = !(await victim.waitForClose(500));

	for (let attempt = 0; attempt < 6; attempt += 1) victim.sendMalformed();
	const closedOnMalformed = await victim.waitForClose(5_000);

	return { illegalRejected: rejected, survivedIllegal, closedOnMalformed };
}

async function waitForArchive(cookie, matchId, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const response = await fetch(`${webOrigin}/api/v1/matches/${matchId}`, { headers: { cookie } });
		if (response.ok && (await response.json()).replayAvailable) return true;
		await sleep(1_000);
	}
	return false;
}

async function main() {
	log('starting', { pairs, turns, webOrigin });
	const startedAt = performance.now();

	// 1件の失敗で全体を止めない。落ちた対戦は errors に積んで最後に報告する。
	const formed = await formMatches();
	log('matched', { matches: formed.length });

	const settled = await Promise.allSettled(formed.map((match, index) => playMatch(match, index)));
	const matches = [];
	for (const [index, result] of settled.entries()) {
		if (result.status === 'fulfilled') matches.push(result.value);
		else {
			errors.push(`${formed[index].tag}: ${result.reason?.message ?? result.reason}`);
			if (process.env.EMERALD_DEBUG) console.error(result.reason);
		}
	}
	log('matches in progress', { ok: matches.length, failed: errors.length });
	assert(matches.length > 0, 'no match reached the playing phase');

	log('reconnect storm done', { reconnected: await reconnectStorm(matches) });

	const flood = await invalidOperationFlood(matches[0]);
	log('invalid operation flood', flood);

	// 終局させる。投了も「手番の座席」からしか出せない（MatchRoom の手番検査）。
	for (const match of matches) {
		const closer = match.bySeat[turns % 2];
		try {
			await closer.act({ type: 'concede' });
		} catch (error) {
			errors.push(`${match.tag}: concede failed (${error.message})`);
		}
	}

	const archived = await Promise.all(
		matches.map((match) =>
			timed(metrics.archive, () => waitForArchive(match.guests[0].cookie, match.matchId))
		)
	);

	// Queue で片付かなかった分は、設計どおりの代替経路（毎時 Cron の再照合）で拾えるか
	// を見る（doc/designs/03-tech-stack.md 4.3）。同時終局が重なるとローカルの D1 は
	// SQLITE_BUSY で再試行に落ちるため、ここが実際に効くかどうかが公開前の判断材料になる。
	if (archived.includes(false)) {
		log('queue path incomplete, triggering the hourly cron fallback', {
			pending: archived.filter((done) => !done).length
		});
		await fetch(`${realtimeOrigin}/cdn-cgi/handler/scheduled?cron=0+*+*+*+*`);
		for (const [index, done] of archived.entries()) {
			if (done) continue;
			archived[index] = await timed(metrics.archiveFallback, () =>
				waitForArchive(matches[index].guests[0].cookie, matches[index].matchId)
			);
		}
	}

	const archivedCount = archived.filter(Boolean).length;

	for (const match of matches) for (const player of match.players) player.close();

	const summary = {
		pairs,
		turns,
		matchesCompleted: matches.length,
		commandsSent: metrics.command.length,
		archived: `${archivedCount}/${matches.length}`,
		invalidFlood: flood,
		elapsedMs: Math.round(performance.now() - startedAt),
		errors: errors.length,
		latencyMs: Object.fromEntries(
			Object.entries(metrics)
				.map(([name, samples]) => [name, stats(samples)])
				.filter(([, value]) => value)
		)
	};
	console.log(JSON.stringify(summary, null, 2));

	if (errors.length > 0) {
		console.error('[load-test] errors:');
		for (const message of errors) console.error(`  - ${message}`);
	}
	assert(archivedCount === matches.length, 'some matches were never archived');
	assert(flood.illegalRejected === 8, 'illegal commands must be rejected one by one');
	assert(flood.survivedIllegal, 'a legal-but-illegal command must not close the connection');
	assert(flood.closedOnMalformed, 'the DO did not close a connection flooding malformed frames');
	assert(errors.length === 0, `${errors.length} error(s) during the run`);
	log('DONE ✅');
}

await main();
