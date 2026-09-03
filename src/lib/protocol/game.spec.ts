import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { GameActionSchema, MapSeedSchema } from './game';

describe('ゲーム入力スキーマ', () => {
	it('有効なseedと行動を受理する', () => {
		expect(v.parse(MapSeedSchema, ' emerald-01 ')).toBe('emerald-01');
		expect(
			v.parse(GameActionSchema, {
				type: 'move',
				pieceId: '0:nushi',
				toCellId: '3:4'
			})
		).toEqual({ type: 'move', pieceId: '0:nushi', toCellId: '3:4' });
	});

	it('未定義キーと不正座標を拒否する', () => {
		expect(() =>
			v.parse(GameActionSchema, {
				type: 'move',
				pieceId: '0:nushi',
				toCellId: '9:9',
				admin: true
			})
		).toThrow();
	});
});
