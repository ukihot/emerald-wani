import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { ClientMessageSchema, CommandSchema } from './ws';

describe('WS メッセージスキーマ', () => {
	it('hello を受理する', () => {
		const result = v.safeParse(ClientMessageSchema, { t: 'hello', ticket: 'abc.def' });
		expect(result.success).toBe(true);
	});

	it('hello の未定義キーを拒否する', () => {
		const result = v.safeParse(ClientMessageSchema, {
			t: 'hello',
			ticket: 'abc.def',
			extra: 'nope'
		});
		expect(result.success).toBe(false);
	});

	it('act に包んだ submitDeployment を受理する', () => {
		const result = v.safeParse(ClientMessageSchema, {
			t: 'act',
			actionId: 'a1',
			baseRev: 0,
			action: {
				type: 'submitDeployment',
				placements: [{ kind: 'nushi', cellId: '3:8' }]
			}
		});
		expect(result.success).toBe(true);
	});

	it('act に包んだ move を受理する', () => {
		const result = v.safeParse(ClientMessageSchema, {
			t: 'act',
			actionId: 'a2',
			baseRev: 1,
			action: { type: 'move', pieceId: '0:nushi', toCellId: '3:7' }
		});
		expect(result.success).toBe(true);
	});

	it('endTurn / concede を受理する', () => {
		expect(v.safeParse(CommandSchema, { type: 'endTurn' }).success).toBe(true);
		expect(v.safeParse(CommandSchema, { type: 'concede' }).success).toBe(true);
	});

	it('resync を受理する', () => {
		expect(v.safeParse(ClientMessageSchema, { t: 'resync' }).success).toBe(true);
	});

	it('不正な t を拒否する', () => {
		expect(v.safeParse(ClientMessageSchema, { t: 'bogus' }).success).toBe(false);
	});

	it('act の baseRev が負数なら拒否する', () => {
		const result = v.safeParse(ClientMessageSchema, {
			t: 'act',
			actionId: 'a3',
			baseRev: -1,
			action: { type: 'endTurn' }
		});
		expect(result.success).toBe(false);
	});
});
