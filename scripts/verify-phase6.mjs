// フェーズ6（セキュリティ強化）のスモークテスト。
//
//   pnpm dev            # 別ターミナルで起動しておく
//   node scripts/verify-phase6.mjs
//
// 検証する内容（doc/designs/11-security-controls.md / 14-observability.md）:
//   1. セキュリティヘッダーと CSP（nonce 方式、Turnstile の許可、frame-ancestors）
//   2. 管理画面: 未認証は 401、ゲストは 404、役割を持っていても MFA 未設定なら入れない
//   3. ゲスト発行の門: Turnstile → バースト（3/60秒） → 1時間3件（専用 DO）を、
//      画面経由と `/api/auth/sign-in/anonymous` の**両方**に掛けていること
//   4. 監査: security_event に記録され、**生 IP を保存していない**こと
//   5. WS Upgrade の粗いレート制限（realtime Worker、30/60秒）
//   6. 週次エクスポート（D1 → R2）が cron で走ること
//
// 既定では「1時間の窓」の検証で61秒待つ（バースト制限と区別するため）。
// 省略するには EMERALD_SKIP_SLOW=1 を付ける。

import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const webOrigin = process.env.EMERALD_WEB_ORIGIN ?? 'http://localhost:5173';
const realtimeOrigin = process.env.EMERALD_REALTIME_ORIGIN ?? 'http://127.0.0.1:8787';
const skipSlow = process.env.EMERALD_SKIP_SLOW === '1';

/** この実行専用の IP。前回の実行や他のスクリプトの窓と混ざらないようにする。 */
const testIp = `198.51.100.${10 + Math.floor(Math.random() * 200)}`;

function log(label, ...rest) {
	console.log(`[verify-phase6] ${label}`, ...rest);
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * ローカル D1 へ問い合わせる（dev 専用。wrangler の --json をそのまま読む）。
 * Windows では shell 経由になるため、SQL は二重引用符で囲んで1引数に保つ
 * （SQL 側の引用符は単引用符のみを使うこと）。
 */
function queryD1(sql) {
	const out = execFileSync(
		'npx',
		['wrangler', 'd1', 'execute', 'emerald-wani-db', '--local', '--json', '--command', `"${sql}"`],
		{ encoding: 'utf8', shell: true }
	);
	return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}

function sessionCookieFrom(response) {
	const raw = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie')];
	const entries = raw.filter(Boolean).map((value) => value.split(';', 1)[0]);
	return entries.find((entry) => entry.includes('session_token')) ?? entries[0] ?? null;
}

async function issueGuest(headers = {}) {
	return fetch(`${webOrigin}/api/auth/sign-in/anonymous`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: '{}'
	});
}

// ── 1. セキュリティヘッダーと CSP ────────────────────────────────────────
{
	const response = await fetch(`${webOrigin}/home`);
	assert(response.ok, `home: HTTP ${response.status}`);
	const h = response.headers;
	assert(h.get('x-content-type-options') === 'nosniff', 'X-Content-Type-Options が無い');
	assert(h.get('referrer-policy') === 'same-origin', 'Referrer-Policy が無い');
	assert(h.get('cross-origin-opener-policy') === 'same-origin', 'COOP が無い');
	assert(h.get('cross-origin-resource-policy') === 'same-origin', 'CORP が無い');
	assert(h.get('permissions-policy')?.includes('geolocation=()'), 'Permissions-Policy が無い');
	assert(h.get('strict-transport-security')?.includes('max-age=31536000'), 'HSTS が無い');

	const csp = h.get('content-security-policy') ?? '';
	assert(csp.includes("default-src 'none'"), 'CSP: default-src none が無い');
	assert(/script-src[^;]*'nonce-/.test(csp), 'CSP: script-src の nonce が無い');
	assert(!/script-src[^;]*unsafe-inline/.test(csp), 'CSP: script-src に unsafe-inline がある');
	assert(csp.includes('https://challenges.cloudflare.com'), 'CSP: Turnstile が許可されていない');
	assert(csp.includes("frame-ancestors 'none'"), 'CSP: frame-ancestors が無い');
	log('1. セキュリティヘッダーと CSP = ok');
}

// ── 2. 管理画面の認可と MFA 必須 ─────────────────────────────────────────
{
	const anonymous = await fetch(`${webOrigin}/admin`);
	assert(anonymous.status === 401, `admin(未認証): HTTP ${anonymous.status}（401 を期待）`);
	const adminCsp = anonymous.headers.get('content-security-policy') ?? '';
	assert(
		!adminCsp.includes('challenges.cloudflare.com'),
		'admin の CSP から Turnstile の許可が外れていない'
	);
	assert(adminCsp.includes("frame-src 'none'"), 'admin の CSP: frame-src が none でない');

	const guest = await issueGuest();
	const guestCookie = sessionCookieFrom(guest);
	const guestId = (await guest.json()).user.id;
	const asGuest = await fetch(`${webOrigin}/admin`, { headers: { cookie: guestCookie } });
	assert(asGuest.status === 404, `admin(ゲスト): HTTP ${asGuest.status}（404 を期待）`);

	// 役割だけ与えても MFA 未設定なら入れない（doc/designs/10-auth-and-access.md 10.4）。
	queryD1(`UPDATE user SET role = 'admin' WHERE id = '${guestId}'`);
	const asAdmin = await fetch(`${webOrigin}/admin`, {
		headers: { cookie: guestCookie },
		redirect: 'manual'
	});
	queryD1(`UPDATE user SET role = 'user' WHERE id = '${guestId}'`);
	assert(asAdmin.status === 303, `admin(MFA未設定): HTTP ${asAdmin.status}（303 を期待）`);
	assert(
		asAdmin.headers.get('location')?.includes('/admin/mfa'),
		'MFA 未設定の管理者が /admin/mfa へ誘導されない'
	);
	log('2. 管理画面の認可（401 / 404 / MFA 必須）= ok');
}

// ── 3. ゲスト発行の門 ────────────────────────────────────────────────────
{
	const ipHeader = { 'cf-connecting-ip': testIp };
	for (let i = 1; i <= 3; i += 1) {
		const response = await issueGuest(ipHeader);
		assert(response.status === 200, `ゲスト発行 ${i}件目: HTTP ${response.status}`);
	}

	// 4件目は60秒バーストの上限（RL_GUEST_BURST）で止まる。
	const burst = await issueGuest(ipHeader);
	assert(burst.status === 429, `4件目: HTTP ${burst.status}（429 を期待）`);

	// 画面経由（form action）にも同じ門が掛かっている。
	const viaForm = await fetch(`${webOrigin}/home?/playAsGuest`, {
		method: 'POST',
		headers: {
			...ipHeader,
			origin: webOrigin,
			'content-type': 'application/x-www-form-urlencoded'
		},
		body: new URLSearchParams({}),
		redirect: 'manual'
	});
	assert(viaForm.status !== 303, '画面経由のゲスト発行が制限を素通りした');

	if (skipSlow) {
		log('3. ゲスト発行の門（バースト）= ok（1時間窓の検証は EMERALD_SKIP_SLOW で省略）');
	} else {
		// バーストの窓が空いた後も、1時間3件の窓（専用 DO）が止め続ける。
		log('3. 1時間の窓を検証するため61秒待つ…');
		await sleep(61_000);
		const hourly = await issueGuest(ipHeader);
		assert(hourly.status === 429, `61秒後の発行: HTTP ${hourly.status}（429 を期待）`);
		const blocked = queryD1(
			"SELECT COUNT(*) AS n FROM security_event WHERE type = 'guest_issuance_blocked'"
		);
		assert(Number(blocked[0].n) > 0, 'guest_issuance_blocked が記録されていない');
		log('3. ゲスト発行の門（Turnstile / バースト / 1時間3件）= ok');
	}
}

// ── 4. 監査ログ ──────────────────────────────────────────────────────────
{
	const rows = queryD1(
		'SELECT type, severity, user_id, ip_hash, ua_hash, detail_json FROM security_event ORDER BY ts DESC LIMIT 50'
	);
	assert(rows.length > 0, 'security_event が空');
	assert(
		rows.some((row) => row.type === 'guest_issued'),
		'guest_issued が記録されていない'
	);
	assert(
		rows.some((row) => JSON.parse(row.detail_json).via === 'api'),
		'API 経由のゲスト発行が記録されていない'
	);

	// **生 IP を保存していないこと。** これが崩れると 14.1.3 の禁止事項に触れる。
	assert(!JSON.stringify(rows).includes(testIp), 'security_event に生 IP が保存されている');
	for (const row of rows) {
		if (row.ip_hash === null) continue;
		assert(/^[0-9a-f]{32}$/.test(row.ip_hash), `ip_hash の形式が不正: ${row.ip_hash}`);
	}
	log('4. 監査ログ（記録あり・生 IP なし）= ok');
}

// ── 5. WS Upgrade の粗いレート制限 ───────────────────────────────────────
{
	const matchId = crypto.randomUUID();
	const wsOrigin = realtimeOrigin.replace(/^http/, 'ws');
	let rejected = 0;
	for (let i = 0; i < 40; i += 1) {
		const socket = new WebSocket(`${wsOrigin}/ws/matches/${matchId}`, {
			headers: { origin: webOrigin }
		});
		const outcome = await new Promise((resolve) => {
			socket.addEventListener('open', () => resolve('open'), { once: true });
			socket.addEventListener('error', () => resolve('rejected'), { once: true });
		});
		if (outcome === 'open') socket.close();
		else rejected += 1;
	}
	assert(rejected > 0, 'WS Upgrade のレート制限が働いていない（40本すべて確立した）');
	log(`5. WS Upgrade のレート制限 = ok（40本中 ${rejected}本を拒否）`);
}

// ── 6. 週次エクスポート ──────────────────────────────────────────────────
{
	const triggered = await fetch(`${realtimeOrigin}/cdn-cgi/handler/scheduled?cron=0+4+*+*+1`);
	assert(triggered.ok, `週次 cron: HTTP ${triggered.status}`);

	const day = new Date().toISOString().slice(0, 10);
	const target = join(tmpdir(), `emerald-manifest-${Date.now()}.json`);
	execFileSync(
		'npx',
		[
			'wrangler',
			'r2',
			'object',
			'get',
			`emerald-wani-replays/exports/${day}/manifest.json`,
			'--local',
			'--file',
			target
		],
		{ encoding: 'utf8', shell: true }
	);
	const manifest = JSON.parse(readFileSync(target, 'utf8'));
	rmSync(target, { force: true });
	assert(typeof manifest.tables.security_event === 'number', 'manifest に security_event が無い');
	assert(typeof manifest.tables.match === 'number', 'manifest に match が無い');
	log('6. 週次エクスポート（D1 → R2）= ok', manifest.tables);
}

console.log('phase6 smoke: headers=ok admin=ok guest-guard=ok audit=ok ws-rate=ok export=ok');
