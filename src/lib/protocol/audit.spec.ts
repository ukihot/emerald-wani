import { describe, expect, it } from 'vitest';
import {
	clientIp,
	dayKey,
	hashSignal,
	notifyAlert,
	recordSecurityEvent,
	type AuditD1
} from './audit';

/** バインドされた値を記録するだけの D1 スタブ。 */
function fakeD1() {
	const calls: { query: string; values: unknown[] }[] = [];
	const db: AuditD1 = {
		prepare(query) {
			return {
				bind(...values) {
					return {
						async run() {
							calls.push({ query, values });
						}
					};
				}
			};
		}
	};
	return { db, calls };
}

describe('hashSignal', () => {
	const secret = 'test-secret';
	const day1 = Date.UTC(2026, 8, 7, 10, 0, 0);
	const day2 = Date.UTC(2026, 8, 8, 10, 0, 0);

	it('同じ日・同じ入力なら同じ値になる（同日内の同一性判定に使える）', async () => {
		const a = await hashSignal(secret, '203.0.113.9', day1);
		const b = await hashSignal(secret, '203.0.113.9', day1 + 3600_000);
		expect(a).toBe(b);
	});

	it('日付が変われば別の値になる（長期追跡を不能にする）', async () => {
		const a = await hashSignal(secret, '203.0.113.9', day1);
		const b = await hashSignal(secret, '203.0.113.9', day2);
		expect(a).not.toBe(b);
	});

	it('生の値をそのまま含まない', async () => {
		const hashed = await hashSignal(secret, '203.0.113.9', day1);
		expect(hashed).not.toContain('203.0.113.9');
		expect(hashed).toMatch(/^[0-9a-f]{32}$/);
	});

	it('値が無ければ null（記録側で列を NULL にする）', async () => {
		expect(await hashSignal(secret, null, day1)).toBeNull();
		expect(await hashSignal(secret, '', day1)).toBeNull();
	});
});

describe('recordSecurityEvent', () => {
	it('生 IP ではなくハッシュだけを INSERT する', async () => {
		const { db, calls } = fakeD1();
		await recordSecurityEvent(
			db,
			{
				type: 'guest_issued',
				severity: 'info',
				userId: 'u1',
				ipHash: 'deadbeef',
				uaHash: 'cafe',
				detail: { count: 1 }
			},
			1234
		);
		expect(calls).toHaveLength(1);
		expect(calls[0].query).toContain('INSERT INTO security_event');
		expect(calls[0].values.slice(1)).toEqual([
			1234,
			'guest_issued',
			'info',
			'u1',
			'deadbeef',
			'cafe',
			'{"count":1}'
		]);
	});

	it('書き込みに失敗しても例外を投げない（監査の失敗で処理を止めない）', async () => {
		const db: AuditD1 = {
			prepare: () => ({
				bind: () => ({
					run: () => Promise.reject(new Error('D1 down'))
				})
			})
		};
		await expect(
			recordSecurityEvent(db, { type: 'login_failed', severity: 'warn' })
		).resolves.toBeUndefined();
	});
});

describe('notifyAlert', () => {
	it('warn 以下は通知しない', async () => {
		let called = 0;
		const original = globalThis.fetch;
		globalThis.fetch = (async () => {
			called += 1;
			return new Response('ok');
		}) as typeof fetch;
		await notifyAlert('https://example.test/hook', { type: 'login_failed', severity: 'warn' });
		await notifyAlert('https://example.test/hook', { type: 'archive_failed', severity: 'error' });
		globalThis.fetch = original;
		expect(called).toBe(1);
	});
});

describe('clientIp / dayKey', () => {
	it('Cloudflare のヘッダーを優先し、無ければ local へ落とす', () => {
		expect(clientIp(new Headers({ 'cf-connecting-ip': '198.51.100.7' }))).toBe('198.51.100.7');
		expect(clientIp(new Headers({ 'x-forwarded-for': '198.51.100.8, 10.0.0.1' }))).toBe(
			'198.51.100.8'
		);
		expect(clientIp(new Headers())).toBe('local');
	});

	it('日付キーは UTC', () => {
		expect(dayKey(Date.UTC(2026, 8, 7, 23, 59))).toBe('2026-09-07');
	});
});
