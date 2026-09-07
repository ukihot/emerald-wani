import { gzip } from '$protocol/replay';

/**
 * D1 の主要テーブルを週次で R2 へ書き出す（doc/designs/18-availability.md 15.2）。
 *
 * D1 の Time Travel は無料プランで7日しか遡れず、監査ログの保持期間（400日）を
 * 満たせない。Time Travel を超える期間の復旧はこのエクスポートから行う
 * （復元手順と四半期ごとの復元試験は doc/ops/restore-drill.md）。
 *
 * 形式は NDJSON + gzip。行単位で読めるため、部分的に壊れても残りを復旧できる。
 */

/** 書き出す表。`user` は個人情報を含むため、復旧に必要な列だけを選ぶ。 */
const TABLES: { name: string; query: string }[] = [
	{ name: 'match', query: 'SELECT * FROM match' },
	{ name: 'match_player', query: 'SELECT * FROM match_player' },
	{ name: 'player_profile', query: 'SELECT * FROM player_profile' },
	{ name: 'report', query: 'SELECT * FROM report' },
	{ name: 'security_event', query: 'SELECT * FROM security_event' },
	{ name: 'admin_audit', query: 'SELECT * FROM admin_audit' },
	{
		name: 'user',
		query: 'SELECT id, name, email_verified, created_at, is_anonymous, role, banned FROM user'
	}
];

export function exportPrefix(now: number): string {
	return `exports/${new Date(now).toISOString().slice(0, 10)}`;
}

export interface ExportSummary {
	prefix: string;
	rows: Record<string, number>;
}

/** 全表を1回のスキャンで書き出す。件数を返し、監視で「0件」の異常に気づけるようにする。 */
export async function exportTables(env: Env, now: number = Date.now()): Promise<ExportSummary> {
	const prefix = exportPrefix(now);
	const rows: Record<string, number> = {};

	for (const table of TABLES) {
		const { results } = await env.DB.prepare(table.query).all();
		const ndjson = results.map((row) => JSON.stringify(row)).join('\n') + '\n';
		await env.REPLAYS.put(`${prefix}/${table.name}.ndjson.gz`, await gzip(ndjson));
		rows[table.name] = results.length;
	}

	// 復元側が「どの表が揃っているか」を1ファイルで判断できるようにする。
	await env.REPLAYS.put(
		`${prefix}/manifest.json`,
		JSON.stringify({ exportedAt: now, tables: rows }, null, 2)
	);
	return { prefix, rows };
}
