// フェーズ7（公開準備）のスモークテスト。
//
//   pnpm dev            # 別ターミナルで起動しておく
//   pnpm verify:phase7
//
// 検証する内容:
//   1. 規約・プライバシー・セキュリティポリシー・窓口が配信され、窓口の宛先が入っている
//   2. どの画面からも規約・窓口へ1クリックで行ける（フッターの導線）
//   3. /.well-known/security.txt が RFC 9116 の必須項目を持ち、**期限切れ間近でない**
//   4. 公開ページが検索・共有に耐える（robots.txt、title、canonical でないもの）
//   5. 過去版リプレイの互換テストの資産（fixture）が存在する
//   6. ベータ告知が画面に出ている（無保証であることを利用者が見る導線）
//   7. 無効試合（status='void'）が戦績から外れる（インシデント対応の救済経路。
//      ローカルの D1 を直接叩くため、ローカル実行のときだけ確認する）
//
// 負荷・耐性の測定は scripts/load-test.mjs（結果は doc/load-test.md）。

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import {
	Player,
	enqueue,
	fetchTicket,
	placementsFor,
	pollUntilMatched,
	signInGuest
} from './match-client.mjs';

const webOrigin = process.env.EMERALD_WEB_ORIGIN ?? 'http://localhost:5173';

/** security.txt の Expires がこの日数を切ったら失敗させる（窓口不在を防ぐ）。 */
const EXPIRY_WARNING_DAYS = 30;

const CONTACT_EMAIL = 'emerald-wani@jocarium.productions';
const SITE_DOMAIN = 'emerald-wani.jocarium.productions';

function log(label, ...rest) {
	console.log(`[verify-phase7] ${label}`, ...rest);
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

async function getText(path) {
	const response = await fetch(`${webOrigin}${path}`);
	assert(response.ok, `${path}: HTTP ${response.status}`);
	return response.text();
}

// ── 1. 規約・ポリシー・窓口 ──────────────────────────────────────────────
{
	const pages = {
		'/terms': ['利用規約', 'ベータ', '異議申立て', 'サービスの終了'],
		'/privacy': ['プライバシーポリシー', '保存期間', 'Cloudflare', 'Resend'],
		'/security-policy': ['対象範囲', '禁止事項', '受領の確認', '報奨'],
		'/contact': ['お問い合わせ', '異議申立て']
	};
	for (const [path, phrases] of Object.entries(pages)) {
		const html = await getText(path);
		for (const phrase of phrases) {
			assert(html.includes(phrase), `${path}: 「${phrase}」が見当たらない`);
		}
		assert(html.includes(CONTACT_EMAIL), `${path}: 窓口のメールアドレスが載っていない`);
	}
	log('legal pages served with a working contact address');
}

// ── 2. どの画面からも窓口へ行けること ────────────────────────────────────
{
	for (const path of ['/home', '/login', '/signup', '/terms']) {
		const html = await getText(path);
		// SvelteKit の resolve() は相対 URL（`./terms`）を出すため、末尾で照合する。
		for (const target of ['terms', 'privacy', 'security-policy', 'contact']) {
			assert(new RegExp(`href="[^"]*${target}"`).test(html), `${path}: /${target} への導線が無い`);
		}
	}
	// 盤面を全画面で使う画面ではフッターを出さない（出すと操作を隠す）。
	// class 名は CSS バンドルにも載るため、要素の有無で見る。
	const play = await getText('/play');
	assert(!play.includes('<footer'), '/play: 対局画面にフッターが出ている');
	log('footer links reachable from account screens, absent from the board screens');
}

// ── 3. security.txt（RFC 9116） ──────────────────────────────────────────
{
	const text = await getText('/.well-known/security.txt');
	const fields = Object.fromEntries(
		text
			.split('\n')
			.filter((line) => line.trim() && !line.startsWith('#'))
			.map((line) => {
				const at = line.indexOf(':');
				return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
			})
	);

	assert(fields.Contact === `mailto:${CONTACT_EMAIL}`, `Contact が違う: ${fields.Contact}`);
	assert(fields.Policy === `https://${SITE_DOMAIN}/security-policy`, 'Policy の URL が違う');
	assert(fields.Canonical?.startsWith(`https://${SITE_DOMAIN}/`), 'Canonical の URL が違う');
	assert(fields['Preferred-Languages'], 'Preferred-Languages が無い');

	const expires = new Date(fields.Expires);
	assert(!Number.isNaN(expires.getTime()), `Expires が日時として読めない: ${fields.Expires}`);
	const daysLeft = Math.floor((expires.getTime() - Date.now()) / 86_400_000);
	assert(
		daysLeft > EXPIRY_WARNING_DAYS,
		`security.txt の Expires が残り ${daysLeft} 日。更新しないと窓口不在になる`
	);
	log('security.txt is valid', { daysLeft });
}

// ── 4. 公開ページの体裁 ─────────────────────────────────────────────────
{
	const robots = await getText('/robots.txt');
	assert(robots.toLowerCase().includes('user-agent'), 'robots.txt が壊れている');

	for (const path of ['/terms', '/privacy', '/security-policy', '/contact']) {
		const html = await getText(path);
		const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
		assert(title.length > 0, `${path}: <title> が無い`);
		assert(title.includes('エメラルドワニ'), `${path}: <title> にサービス名が無い（${title}）`);
	}
	log('public pages have titles and robots.txt is served');
}

// ── 5. 過去版リプレイの互換資産 ──────────────────────────────────────────
{
	const dir = 'src/lib/protocol/fixtures';
	const fixtures = readdirSync(dir).filter((name) => name.endsWith('.ndjson'));
	assert(fixtures.length >= 2, `${dir}: 互換テストの fixture が足りない`);
	for (const name of fixtures) {
		const header = JSON.parse(readFileSync(`${dir}/${name}`, 'utf8').split('\n', 1)[0]);
		assert(header.ruleVersion && header.mapVersion, `${name}: 版数の記録が無い`);
	}
	log('replay compatibility fixtures present', { fixtures });
}

// ── 6. ベータであることの告知 ───────────────────────────────────────────
{
	const html = await getText('/home');
	assert(html.includes('ベータ'), '/home: ベータ公開中であることが画面に出ていない');
	log('beta notice is visible');
}

// ── 7. 無効試合が戦績から外れる ─────────────────────────
// 「結果を確定できない対戦は無効試合として戦績に計上しない」は、利用規約5節と
// doc/designs/15-incident-response.md 3節で利用者に約束している救済経路である。
// 戦績の集計が match.status を見ていなければ、無効試合化は救済にならない。
if (new URL(webOrigin).hostname === 'localhost') {
	const alice = await signInGuest('void-a');
	const bob = await signInGuest('void-b');
	await enqueue('void-a', alice.cookie);
	await enqueue('void-b', bob.cookie);
	const matchId = await pollUntilMatched('void-a', alice.cookie, 60_000);

	const players = [];
	for (const [offset, guest] of [alice, bob].entries()) {
		const player = new Player(
			`void-${offset}`,
			matchId,
			await fetchTicket(`void-${offset}`, guest.cookie, matchId)
		);
		await player.connect();
		players.push(player);
	}
	const bySeat = { [players[0].seat]: players[0], [players[1].seat]: players[1] };
	await bySeat[0].act({ type: 'submitDeployment', placements: placementsFor(0) });
	await bySeat[1].waitFor('events');
	await bySeat[1].act({ type: 'submitDeployment', placements: placementsFor(1) });
	await bySeat[0].waitFor('events');
	await bySeat[0].act({ type: 'concede' });
	for (const player of players) player.close();

	// アーカイブの書き込みと重なると、ローカルの D1 は一時的な内部エラーを返す
	// （本番の D1 では起きない emulator 側の競合）。1回だけ待って読み直す。
	const recordOf = async (cookie) => {
		for (const attempt of [0, 1]) {
			const response = await fetch(`${webOrigin}/api/v1/me`, { headers: { cookie } });
			if (response.ok) return (await response.json()).record.total;
			if (attempt === 1) assert(false, `/api/v1/me: HTTP ${response.status}`);
			await new Promise((resolve) => setTimeout(resolve, 2_000));
		}
	};

	// 戦績は終局後に Queue consumer が D1 へ書く。反映を待ってから読む。
	let before = 0;
	for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
		before = await recordOf(alice.cookie);
		if (before >= 1) break;
		await new Promise((resolve) => setTimeout(resolve, 2_000));
	}
	assert(before >= 1, '投了した対戦が60秒以内に戦績へ反映されなかった');

	execFileSync(
		'npx',
		[
			'wrangler',
			'd1',
			'execute',
			'emerald-wani-db',
			'--local',
			'--command',
			`"UPDATE match SET status = 'void' WHERE id = '${matchId}'"`
		],
		{ encoding: 'utf8', shell: true }
	);

	const after = await recordOf(alice.cookie);
	assert(after === before - 1, `無効試合が戦績から外れていない（${before} -> ${after}）`);
	log('void matches are excluded from the record', { before, after });
} else {
	log('skipped the void-match check (needs local D1 access)');
}

console.log('\n[verify-phase7] ALL CHECKS PASSED ✅');
