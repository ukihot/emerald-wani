import { describe, expect, it } from 'vitest';
import { matchRule } from './api-rate-limit';
import { withinLimit } from './rate-limit';

describe('matchRule', () => {
	it('書き込み系はそれぞれ専用のバインディングに割り当てる', () => {
		expect(matchRule('/api/v1/matchmaking/enqueue', 'POST')).toBe('RL_MATCHMAKING');
		expect(matchRule('/api/v1/reports', 'POST')).toBe('RL_REPORT_WRITE');
		expect(
			matchRule('/api/v1/matches/0199a0b1-c2d3-7e4f-8a9b-0c1d2e3f4a5b/ws-ticket', 'POST')
		).toBe('RL_WS_TICKET');
	});

	it('一般の GET は既定で RL_API_READ に入る（掛け忘れを作らない）', () => {
		expect(matchRule('/api/v1/me', 'GET')).toBe('RL_API_READ');
		expect(matchRule('/api/v1/matches', 'GET')).toBe('RL_API_READ');
	});

	it('API 以外と対象外のメソッドは制限しない', () => {
		expect(matchRule('/home', 'GET')).toBeNull();
		expect(matchRule('/api/v1/me', 'DELETE')).toBeNull();
		expect(matchRule('/api/v1/reports', 'GET')).toBe('RL_API_READ');
	});
});

describe('withinLimit', () => {
	it('バインディングが無い環境では通す', async () => {
		await expect(withinLimit(undefined, 'k')).resolves.toBe(true);
	});

	it('バインディングの判定をそのまま返す', async () => {
		await expect(withinLimit({ limit: async () => ({ success: false }) }, 'k')).resolves.toBe(
			false
		);
	});

	it('バインディングが壊れてもサービスを止めない', async () => {
		const broken = {
			limit: () => Promise.reject(new Error('binding down'))
		};
		await expect(withinLimit(broken, 'k')).resolves.toBe(true);
	});
});
