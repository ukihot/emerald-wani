import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, MATCH_PAGE_LIMIT_MAX } from './matches';

describe('対戦履歴のカーソル', () => {
	it('終局時刻と対戦IDを往復できる', () => {
		const cursor = encodeCursor(1_700_000_000_000, '0198f0a0-1111-7000-8000-000000000001');
		expect(decodeCursor(cursor)).toEqual({
			endedAt: 1_700_000_000_000,
			matchId: '0198f0a0-1111-7000-8000-000000000001'
		});
	});

	it('URL に載せられる文字だけを使う', () => {
		const cursor = encodeCursor(1_700_000_000_123, 'a/b+c=d');
		expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(decodeCursor(cursor)?.matchId).toBe('a/b+c=d');
	});

	it('壊れたカーソルは null にする（例外にしない）', () => {
		expect(decodeCursor('!!!not-base64!!!')).toBeNull();
		expect(decodeCursor(encodeCursor(1, '').slice(0, 2))).toBeNull();
	});

	it('一覧の上限は50件（doc/designs/09-api-protocol.md 1節）', () => {
		expect(MATCH_PAGE_LIMIT_MAX).toBe(50);
	});
});
