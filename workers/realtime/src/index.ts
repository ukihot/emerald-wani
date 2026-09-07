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

import {
	ARCHIVE_RETRY_BATCH,
	archiveMatch,
	findUnarchivedMatchIds,
	type ArchiveJob
} from './archive';
import { auditAndAlert, clientIp, hashSignal } from '$protocol/audit';
import { exportTables } from './export';

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

		// IP 単位の粗いレート制限（doc/designs/11-security-controls.md 11.4）。
		// Upgrade 要求そのものの頻度だけを見る。チケットの正当性は DO が見る。
		// キーは日次ソルト付きの IP ハッシュ（生 IP は使わない）。
		//
		// ここで拒否した分は `security_event` へ書かない。この経路は最も安価に叩ける
		// ため、拒否のたびに D1 へ INSERT すると攻撃者が D1 の1日の書き込み上限を
		// 削れてしまう。Workers Logs には残す（doc/designs/14-observability.md 3節）。
		const ipHash = await hashSignal(
			env.AUDIT_SALT_SECRET ?? 'development-audit-salt',
			clientIp(request.headers)
		);
		if (env.RL_WS_UPGRADE && ipHash) {
			const { success } = await env.RL_WS_UPGRADE.limit({ key: ipHash });
			if (!success) {
				console.warn('ws upgrade rate limited', ipHash);
				return new Response('Too Many Requests', {
					status: 429,
					headers: { 'Retry-After': '60' }
				});
			}
		}

		// 未検証のまま DO へ転送する。認証は DO 側の `hello` で行う。
		const stub = env.MATCH_ROOM.get(env.MATCH_ROOM.idFromName(matchId));
		return stub.fetch(request);
	},

	/**
	 * 終局した対戦のアーカイブ（doc/designs/07-durable-objects.md 9.2）。
	 *
	 * メッセージには matchId だけが入っている。ログ本体は DO の内部限定 API から
	 * 取得する。失敗したメッセージは `retry()` で Queue のリトライに戻し、規定回数を
	 * 超えたものは DLQ へ送られる。DLQ に落ちても DO の SQLite は保持されたままで、
	 * Cron のスキャンが拾い直す。
	 */
	async queue(batch: MessageBatch<ArchiveJob>, env: Env): Promise<void> {
		for (const message of batch.messages) {
			const matchId = message.body?.matchId;
			if (!matchId) {
				message.ack();
				continue;
			}
			try {
				const outcome = await archiveMatch(env, matchId);
				console.info('archive', outcome, matchId);
				message.ack();
			} catch (error) {
				console.error('archive failed, will retry', matchId, error);
				message.retry();
			}
		}
	},

	/**
	 * アーカイブのフォールバック（doc/designs/03-tech-stack.md 4.3）。
	 *
	 * Queues の無料プランはメッセージを24時間しか保持しないため、Queue の消失が
	 * 永続化の失敗に直結しないよう、D1 の `match.replay_key IS NULL` を定期的に
	 * 直接スキャンして再試行する。
	 */
	async scheduled(event: ScheduledController, env: Env): Promise<void> {
		// 週次: D1 の主要テーブルを R2 へ書き出す（doc/designs/18-availability.md 15.2）。
		// Time Travel（無料プランは7日）を超える期間の復旧元になる。
		if (event.cron === WEEKLY_EXPORT_CRON) {
			try {
				const summary = await exportTables(env);
				console.info('weekly export', summary.prefix, summary.rows);
			} catch (error) {
				console.error('weekly export failed', error);
				await auditAndAlert(env.DB, env.ALERT_WEBHOOK_URL, {
					type: 'archive_failed',
					severity: 'error',
					detail: { at: 'weekly_export', message: String(error) }
				});
			}
			return;
		}

		const pending = await findUnarchivedMatchIds(env, Date.now(), ARCHIVE_RETRY_MIN_AGE_MS);
		if (pending.length === 0) return;

		console.warn('archive fallback: retrying unarchived matches', pending.length);
		for (const matchId of pending) {
			try {
				await archiveMatch(env, matchId);
			} catch (error) {
				console.error('archive fallback failed', matchId, error);
			}
		}
		if (pending.length === ARCHIVE_RETRY_BATCH) {
			console.warn('archive fallback hit the batch limit; more matches remain');
		}
	}
} satisfies ExportedHandler<Env, ArchiveJob>;

/** 週次エクスポートの cron 式（wrangler.jsonc の triggers.crons と一致させること）。 */
const WEEKLY_EXPORT_CRON = '0 4 * * 1';

/**
 * Cron が再試行の対象にするまでの猶予。終局直後は consumer が処理中の可能性が高く、
 * 二重処理は無害だが無駄なので、5分より新しい試合には触れない。
 */
const ARCHIVE_RETRY_MIN_AGE_MS = 5 * 60 * 1000;
