import { describe, expect, it } from 'vitest';
import { signTicket, verifyTicket, type TicketPayload } from './ws-ticket';

const secrets = { v1: 'test-secret-v1', v2: 'test-secret-v2' };

function payload(overrides: Partial<TicketPayload> = {}): TicketPayload {
	return {
		kid: 'v1',
		mid: 'match-1',
		uid: 'user-1',
		seat: 0,
		jti: 'jti-1',
		exp: Math.floor(Date.now() / 1000) + 60,
		rv: 'rules-1.0.0',
		...overrides
	};
}

describe('WS チケットの署名・検証', () => {
	it('正しい鍵で検証に成功する', async () => {
		const original = payload();
		const ticket = await signTicket(original, secrets.v1);
		const result = await verifyTicket(ticket, secrets, Date.now());
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.payload).toEqual(original);
	});

	it('改ざんされたペイロード（座席のすり替え）を拒否する', async () => {
		const ticket = await signTicket(payload({ seat: 0 }), secrets.v1);
		const [, signaturePart] = ticket.split('.');
		// 正規の署名はそのままに、ペイロードだけ座席1へ書き換える。
		const forgedPayloadBytes = new TextEncoder().encode(JSON.stringify(payload({ seat: 1 })));
		let binary = '';
		for (const byte of forgedPayloadBytes) binary += String.fromCharCode(byte);
		const forgedPayloadPart = btoa(binary)
			.replaceAll('+', '-')
			.replaceAll('/', '_')
			.replace(/=+$/, '');
		const forged = `${forgedPayloadPart}.${signaturePart}`;
		const result = await verifyTicket(forged, secrets, Date.now());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('bad_signature');
	});

	it('期限切れを拒否する', async () => {
		const expired = payload({ exp: Math.floor(Date.now() / 1000) - 10 });
		const ticket = await signTicket(expired, secrets.v1);
		const result = await verifyTicket(ticket, secrets, Date.now());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('expired');
	});

	it('未知の kid を拒否する', async () => {
		const ticket = await signTicket(payload({ kid: 'v9' }), secrets.v1);
		const result = await verifyTicket(ticket, secrets, Date.now());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('unknown_kid');
	});

	it('鍵ローテーション中の旧鍵(v1)・新鍵(v2)を両方受理する', async () => {
		const ticketV1 = await signTicket(payload({ kid: 'v1' }), secrets.v1);
		const ticketV2 = await signTicket(payload({ kid: 'v2' }), secrets.v2);
		expect((await verifyTicket(ticketV1, secrets, Date.now())).ok).toBe(true);
		expect((await verifyTicket(ticketV2, secrets, Date.now())).ok).toBe(true);
	});

	it('壊れた形式を拒否する', async () => {
		const result = await verifyTicket('not-a-ticket', secrets, Date.now());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('malformed');
	});
});
