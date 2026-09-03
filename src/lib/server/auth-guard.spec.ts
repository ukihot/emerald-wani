import { describe, expect, it } from 'vitest';
import { requireOwner, requireUser } from './auth-guard';

function locals(userId?: string): App.Locals {
	return {
		auth: {} as App.Locals['auth'],
		...(userId
			? {
					user: { id: userId } as App.Locals['user'],
					session: { id: 'session-1', userId } as App.Locals['session']
				}
			: {})
	};
}

describe('認可ガード', () => {
	it('未認証を401で拒否する', () => {
		expect(() => requireUser(locals())).toThrow(expect.objectContaining({ status: 401 }));
	});

	it('他人の資源を404で隠す', () => {
		expect(() => requireOwner(locals('user-a'), 'user-b')).toThrow(
			expect.objectContaining({ status: 404 })
		);
	});

	it('所有者を通す', () => {
		expect(requireOwner(locals('user-a'), 'user-a').user.id).toBe('user-a');
	});
});
