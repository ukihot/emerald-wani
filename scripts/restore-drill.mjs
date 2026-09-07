// 復元試験（doc/designs/18-availability.md 15.4）。
//
// 「バックアップがある」だけでは復旧できない。週次エクスポート（R2）から実際に
// D1 へ書き戻し、件数の一致と所要時間（RTO）を測る。**四半期ごとに実行し、
// 結果を doc/ops/restore-drill.md へ記録する。**
//
//   node scripts/restore-drill.mjs                       # ローカルへ復元（既定）
//   node scripts/restore-drill.mjs --date 2026-09-07     # 復元元のエクスポートを指定
//   node scripts/restore-drill.mjs --target emerald-wani-db-stg --remote
//
// 本番データは使わない（15.2「本番データは開発・ステージングへコピーしない」）。
// staging で行う場合は、同等規模のダミーデータを本番と同じ手順で復元する。

import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const index = args.indexOf(`--${name}`);
	return index >= 0 ? args[index + 1] : fallback;
};
const remote = args.includes('--remote');
const bucket = flag('bucket', 'emerald-wani-replays');
const targetDb = flag('target', 'emerald-wani-db');
const day = flag('date', new Date().toISOString().slice(0, 10));
const scope = remote ? '--remote' : '--local';

/** 復元する表と、件数を数えるときの表名。順序は外部キーの依存に合わせる。 */
const TABLES = [
	'player_profile',
	'match',
	'match_player',
	'report',
	'security_event',
	'admin_audit'
];

const work = mkdtempSync(join(tmpdir(), 'emerald-restore-'));

function wrangler(argv) {
	return execFileSync('npx', ['wrangler', ...argv], {
		encoding: 'utf8',
		shell: true,
		maxBuffer: 64 * 1024 * 1024
	});
}

function d1(db, sql) {
	const out = wrangler(['d1', 'execute', db, scope, '--json', '--command', `"${sql}"`]);
	return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}

function r2Get(key, file) {
	wrangler(['r2', 'object', 'get', `${bucket}/${key}`, scope, '--file', file]);
}

/** SQLite の文字列リテラルへ落とす。復元は運用者が回すので値の型だけを見る。 */
function literal(value) {
	if (value === null || value === undefined) return 'NULL';
	if (typeof value === 'number') return String(value);
	return `'${String(value).replace(/'/g, "''")}'`;
}

console.log(`[restore-drill] 復元元: r2://${bucket}/exports/${day}/ → D1 ${targetDb} (${scope})`);
const startedAt = Date.now();

// 1. マニフェストで「何が何件あるはず」かを確定させる。
const manifestPath = join(work, 'manifest.json');
r2Get(`exports/${day}/manifest.json`, manifestPath);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
console.log('[restore-drill] マニフェスト', manifest.tables);

// 2. 各表を取り出して INSERT 文へ変換する。
const statements = [];
for (const table of TABLES) {
	const gzPath = join(work, `${table}.ndjson.gz`);
	r2Get(`exports/${day}/${table}.ndjson.gz`, gzPath);
	const rows = gunzipSync(readFileSync(gzPath))
		.toString('utf8')
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line));

	for (const row of rows) {
		const columns = Object.keys(row);
		statements.push(
			`INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${columns
				.map((column) => literal(row[column]))
				.join(', ')});`
		);
	}
	console.log(`[restore-drill] ${table}: ${rows.length}行を読み込み`);
}

// 3. 書き戻す。`INSERT OR REPLACE` なので、途中で失敗しても再実行できる。
const sqlPath = join(work, 'restore.sql');
writeFileSync(sqlPath, statements.join('\n'), 'utf8');
if (statements.length > 0) {
	wrangler(['d1', 'execute', targetDb, scope, '--yes', '--file', sqlPath]);
}

// 4. 件数を突き合わせる。ここが合わなければ「復元できた」と言わない。
const mismatches = [];
for (const table of TABLES) {
	const expected = manifest.tables[table] ?? 0;
	const actual = Number(d1(targetDb, `SELECT COUNT(*) AS n FROM ${table}`)[0].n);
	if (actual < expected) mismatches.push(`${table}: 期待 ${expected} / 実際 ${actual}`);
}

const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
rmSync(work, { recursive: true, force: true });

if (mismatches.length > 0) {
	console.error('[restore-drill] 件数が一致しない:', mismatches.join(', '));
	process.exit(1);
}

console.log(`[restore-drill] 完了: ${statements.length}行を復元、所要 ${elapsedSeconds}秒`);
console.log(
	'[restore-drill] doc/ops/restore-drill.md に日付・担当・所要時間・発見事項を追記すること'
);
console.log(`[restore-drill] 参考: 監査ログの RTO は72時間、対戦結果は8時間（15.4）`);
