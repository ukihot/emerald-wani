import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyTurnstile } from './turnstile';

afterEach(() => vi.unstubAllGlobals());

function stubSiteVerify(body: unknown) {
	const fetchMock = vi.fn(async () => new Response(JSON.stringify(body)));
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

describe('verifyTurnstile', () => {
	it('鍵が無いローカル開発では素通りする', async () => {
		const result = await verifyTurnstile(undefined, 'local', { environment: 'development' });
		expect(result).toEqual({ ok: true, skipped: true });
	});

	it('development 以外で鍵が無ければ拒否する（フェイルクローズ）', async () => {
		const result = await verifyTurnstile('token', '198.51.100.1', { environment: 'production' });
		expect(result).toEqual({ ok: false, reason: 'missing-secret' });
	});

	it('鍵があるのにトークンが無ければ拒否する', async () => {
		const result = await verifyTurnstile(undefined, 'local', { secret: 's' });
		expect(result).toEqual({ ok: false, reason: 'missing-token' });
	});

	it('siteverify が success なら通す', async () => {
		const fetchMock = stubSiteVerify({ success: true });
		const result = await verifyTurnstile('token', '198.51.100.1', { secret: 's' });
		expect(result).toEqual({ ok: true, skipped: false });
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it('siteverify が失敗ならエラーコードを添えて拒否する', async () => {
		stubSiteVerify({ success: false, 'error-codes': ['timeout-or-duplicate'] });
		const result = await verifyTurnstile('token', 'local', { secret: 's' });
		expect(result).toEqual({ ok: false, reason: 'timeout-or-duplicate' });
	});

	it('siteverify へ到達できなければ拒否する（フェイルクローズ）', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('network down');
			})
		);
		const result = await verifyTurnstile('token', 'local', { secret: 's' });
		expect(result).toEqual({ ok: false, reason: 'siteverify-unreachable' });
	});
});
