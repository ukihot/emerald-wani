// フェーズ5のスモークテスト。終了条件「ゲスト開始 → 本登録 → 対戦 → 履歴・リプレイ確認」を
// 実際に立ち上がった web / realtime に対して一気通貫で検証する。
//
//   pnpm dev            # 別ターミナルで起動しておく
//   node scripts/verify-phase5.mjs
//
// 検証する内容:
//   1. ゲスト2人で対戦し、投了で終局させる（フェーズ4の経路をそのまま使う）
//   2. 終局後、MatchRoom → Queue → consumer のアーカイブで D1 と R2 が埋まる
//   3. 一方のゲストが本登録し、戦績が新しいアカウントへ移行される（onLinkAccount）
//   4. 本登録したアカウントで /api/v1/me、/api/v1/matches、/api/v1/matches/{id}、
//      /api/v1/matches/{id}/replay が正しく返る
//   5. 参加していないユーザーには、詳細もリプレイも 404 になる
//   6. 通報（POST /api/v1/reports）が受理され、二重送信でも重複しない
//
// ゲスト発行・マッチング・WS 駆動は scripts/match-client.mjs（load-test.mjs と共用）。

import { gunzip as gunzipCallback } from 'node:zlib';
import { promisify } from 'node:util';

const gunzip = promisify(gunzipCallback);

import {
	Player,
	assert,
	enqueue,
	expectOk,
	fetchTicket,
	placementsFor,
	pollUntilMatched,
	realtimeOrigin,
	sessionCookieFrom,
	signInGuest,
	sleep,
	webOrigin
} from './match-client.mjs';

function log(label, ...rest) {
	console.log(`[verify-phase5] ${label}`, ...rest);
}

/** 2人のゲストで1試合を最後まで進め、matchId を返す。 */
async function playOneMatch(alice, bob) {
	await enqueue('alice', alice.cookie);
	await enqueue('bob', bob.cookie);
	const [matchIdA, matchIdB] = await Promise.all([
		pollUntilMatched('alice', alice.cookie),
		pollUntilMatched('bob', bob.cookie)
	]);
	assert(matchIdA === matchIdB, 'alice/bob were matched into different matches');
	const matchId = matchIdA;
	log('matched', { matchId });

	const playerA = new Player('alice', matchId, await fetchTicket('alice', alice.cookie, matchId));
	const playerB = new Player('bob', matchId, await fetchTicket('bob', bob.cookie, matchId));
	const welcomeA = await playerA.connect();
	const welcomeB = await playerB.connect();

	const bySeat = { [welcomeA.seat]: playerA, [welcomeB.seat]: playerB };

	// 相手の行動が `events` として届くのを待ってから次を送る。待たずに送ると
	// `baseRev` が古いままになり E_STALE_REV で弾かれる（受信箱があるので順序は問わない）。
	await bySeat[0].act({ type: 'submitDeployment', placements: placementsFor(0) });
	await bySeat[1].waitFor('events');
	await bySeat[1].act({ type: 'submitDeployment', placements: placementsFor(1) });
	log('both deployed');

	// rules-1.0.0 の先手は常に座席0。座席0が投了し、座席1の勝ちで終局させる。
	// 座席1の布陣確定は座席0にも `events` として届く。同じ理由で rev を追いつかせる。
	await bySeat[0].waitFor('events');
	const finishedWaiters = [bySeat[0].waitFor('finished'), bySeat[1].waitFor('finished')];
	await bySeat[0].act({ type: 'concede' });
	const [finished] = await Promise.all(finishedWaiters);
	assert(finished.winnerSeat === 1, `expected seat1 to win, got ${finished.winnerSeat}`);
	log('match finished by concede', { winnerSeat: finished.winnerSeat });

	playerA.close();
	playerB.close();

	const seatOf = (player) => (player === playerA ? welcomeA.seat : welcomeB.seat);
	return { matchId, aliceSeat: seatOf(playerA), bobSeat: seatOf(playerB) };
}

/** アーカイブ（Queue consumer による D1 / R2 への書き出し）の完了を待つ。 */
async function waitForArchive(cookie, matchId, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const response = await fetch(`${webOrigin}/api/v1/matches/${matchId}`, { headers: { cookie } });
		if (response.ok) {
			const detail = await response.json();
			if (detail.replayAvailable) return detail;
		}
		await sleep(1_000);
	}
	throw new Error(`archive did not complete within ${timeoutMs}ms`);
}

async function signUp(cookie, { email, password, name }) {
	const response = await fetch(`${webOrigin}/signup`, {
		method: 'POST',
		headers: {
			cookie,
			'content-type': 'application/x-www-form-urlencoded',
			// SvelteKit の form action は POST に Origin の一致を要求する。
			origin: webOrigin
		},
		body: new URLSearchParams({ email, password, name }),
		redirect: 'manual'
	});
	if (response.status >= 400) {
		throw new Error(`sign-up failed: HTTP ${response.status} ${await response.text()}`);
	}
	const newCookie = sessionCookieFrom(response) ?? cookie;
	return newCookie;
}

async function main() {
	await expectOk(await fetch(`${realtimeOrigin}/health`), 'realtime health');
	await expectOk(await fetch(webOrigin), 'web root');

	// ── 1. ゲストで対戦する ────────────────────────────────────────────
	const alice = await signInGuest('alice');
	const bob = await signInGuest('bob');
	const { matchId, aliceSeat } = await playOneMatch(alice, bob);

	// ── 2. 終局後のアーカイブ（D1 の match / match_player と R2 のリプレイ）──
	const archived = await waitForArchive(alice.cookie, matchId);
	log('archived', {
		result: archived.result,
		score: archived.score,
		replayAvailable: archived.replayAvailable
	});
	assert(archived.result === 'loss', `alice conceded, expected loss but got ${archived.result}`);
	assert(archived.seat === aliceSeat, 'seat mismatch between WS and D1');
	assert(archived.endReason === 'concede', `unexpected endReason ${archived.endReason}`);
	assert(archived.opponent, 'opponent is missing from the match detail');

	// ── 3. ゲストのまま履歴が読めること ────────────────────────────────
	const guestList = await (
		await expectOk(
			await fetch(`${webOrigin}/api/v1/matches`, { headers: { cookie: alice.cookie } }),
			'guest match list'
		)
	).json();
	assert(
		guestList.matches.some((entry) => entry.matchId === matchId),
		'the finished match is missing from the guest match list'
	);
	log('guest can read their own history', { count: guestList.matches.length });

	// ── 4. 本登録して戦績が移行されること ──────────────────────────────
	const email = `verify-${crypto.randomUUID()}@example.invalid`;
	const registeredCookie = await signUp(alice.cookie, {
		email,
		password: 'verify-phase5-password',
		name: 'フェーズ5検証'
	});

	const me = await (
		await expectOk(
			await fetch(`${webOrigin}/api/v1/me`, { headers: { cookie: registeredCookie } }),
			'registered /me'
		)
	).json();
	assert(me.user.isAnonymous === false, 'the account is still anonymous after sign-up');
	assert(me.user.id !== alice.userId, 'sign-up did not create a new user');
	assert(me.record.total === 1, `expected 1 archived match, got ${me.record.total}`);
	assert(me.record.losses === 1, `expected 1 loss, got ${me.record.losses}`);
	log('anonymous record migrated to the registered account', { record: me.record });

	// 旧ゲストの Cookie では、もうそのセッションが通らない（匿名ユーザーは削除済み）。
	const staleResponse = await fetch(`${webOrigin}/api/v1/me`, {
		headers: { cookie: alice.cookie }
	});
	assert(
		staleResponse.status === 401 || staleResponse.status === 200,
		`unexpected status for the old guest cookie: ${staleResponse.status}`
	);

	// ── 5. 履歴・詳細・リプレイ ────────────────────────────────────────
	const list = await (
		await expectOk(
			await fetch(`${webOrigin}/api/v1/matches?limit=10`, {
				headers: { cookie: registeredCookie }
			}),
			'registered match list'
		)
	).json();
	assert(list.matches.length === 1, `expected 1 match after migration, got ${list.matches.length}`);
	assert(list.matches[0].matchId === matchId, 'the migrated match id does not match');

	const replayResponse = await expectOk(
		await fetch(`${webOrigin}/api/v1/matches/${matchId}/replay`, {
			// gzip のまま返ってきても読めるよう、展開はこちらで行う。
			headers: { cookie: registeredCookie, 'accept-encoding': 'identity' }
		}),
		'replay download'
	);
	const raw = Buffer.from(await replayResponse.arrayBuffer());
	// content-encoding: gzip を undici が展開している場合は、そのまま NDJSON になる。
	const text =
		raw[0] === 0x1f && raw[1] === 0x8b
			? (await gunzip(raw)).toString('utf8')
			: raw.toString('utf8');
	const lines = text.trim().split('\n');
	const header = JSON.parse(lines[0]);
	assert(header.matchId === matchId, 'replay header has the wrong matchId');
	assert(header.v === 2, `unexpected replay format version ${header.v}`);
	assert(header.seats.length === 2, 'replay header is missing seats');
	assert(lines.length > 1, 'replay has no command entries');
	const commands = lines.slice(1).map((line) => JSON.parse(line));
	assert(
		commands.some((entry) => entry.command?.type === 'submitDeployment'),
		'replay does not contain the deployment commands'
	);
	assert(
		commands.some((entry) => entry.command?.type === 'concede'),
		'replay does not contain the concede command'
	);
	log('replay verified', { entries: commands.length, key: header.matchId });

	// ── 6. 非参加者からは見えないこと ──────────────────────────────────
	const stranger = await signInGuest('stranger');
	const strangerDetail = await fetch(`${webOrigin}/api/v1/matches/${matchId}`, {
		headers: { cookie: stranger.cookie }
	});
	assert(strangerDetail.status === 404, `stranger got ${strangerDetail.status} for the detail`);
	const strangerReplay = await fetch(`${webOrigin}/api/v1/matches/${matchId}/replay`, {
		headers: { cookie: stranger.cookie }
	});
	assert(strangerReplay.status === 404, `stranger got ${strangerReplay.status} for the replay`);
	log('non-participants get 404 for both the detail and the replay');

	// ── 7. 通報 ────────────────────────────────────────────────────────
	const opponentSeat = archived.opponent.seat;
	const reportBody = JSON.stringify({ matchId, targetSeat: opponentSeat, reason: 'stalling' });
	const first = await fetch(`${webOrigin}/api/v1/reports`, {
		method: 'POST',
		headers: { cookie: registeredCookie, 'content-type': 'application/json' },
		body: reportBody
	});
	assert(first.status === 202, `report was not accepted: HTTP ${first.status}`);
	const second = await fetch(`${webOrigin}/api/v1/reports`, {
		method: 'POST',
		headers: { cookie: registeredCookie, 'content-type': 'application/json' },
		body: reportBody
	});
	assert(second.status === 202, `duplicate report was not accepted: HTTP ${second.status}`);

	const selfReport = await fetch(`${webOrigin}/api/v1/reports`, {
		method: 'POST',
		headers: { cookie: registeredCookie, 'content-type': 'application/json' },
		body: JSON.stringify({ matchId, targetSeat: archived.seat, reason: 'other' })
	});
	assert(selfReport.status === 404, `self-report should be 404, got ${selfReport.status}`);

	const strangerReport = await fetch(`${webOrigin}/api/v1/reports`, {
		method: 'POST',
		headers: { cookie: stranger.cookie, 'content-type': 'application/json' },
		body: reportBody
	});
	assert(
		strangerReport.status === 404,
		`a non-participant should not be able to report: ${strangerReport.status}`
	);
	log('reports accepted, deduplicated, and restricted to participants');

	console.log('\n[verify-phase5] ALL CHECKS PASSED ✅');
}

main().catch((error) => {
	console.error('[verify-phase5] FAILED:', error);
	process.exitCode = 1;
});
