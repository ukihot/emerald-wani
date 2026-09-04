import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetPasswordEmail, sendEmail, verificationEmail } from './email';

/** doc/designs/10-auth-and-access.md「メール配送の運用」、doc/email.md。 */

afterEach(() => {
	vi.restoreAllMocks();
});

describe('sendEmail', () => {
	it('鍵が無いローカル開発では送信せずログへ出す', async () => {
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		const fetchSpy = vi.spyOn(globalThis, 'fetch');

		const result = await sendEmail({}, { to: 'a@example.com', subject: 's', text: 't' });

		expect(result).toEqual({ status: 'logged' });
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(info).toHaveBeenCalled();
	});

	it('本番相当（requireProvider）では未設定を失敗として返す', async () => {
		const result = await sendEmail(
			{ requireProvider: true },
			{ to: 'a@example.com', subject: 's', text: 't' }
		);
		expect(result.status).toBe('failed');
	});

	it('鍵があれば配送業者の API を1回だけ呼ぶ', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 }));

		const result = await sendEmail(
			{ apiKey: 'key', from: 'no-reply@example.com' },
			{ to: 'a@example.com', subject: 's', text: 't' }
		);

		expect(result).toEqual({ status: 'sent', id: 'msg_1' });
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [, init] = fetchSpy.mock.calls[0];
		expect(JSON.parse(String(init?.body))).toMatchObject({ to: ['a@example.com'] });
	});

	it('配送業者のエラー本文をログに残さない（メールアドレスが含まれうるため）', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response('a@example.com is invalid', { status: 422 })
		);

		const result = await sendEmail(
			{ apiKey: 'key', from: 'no-reply@example.com' },
			{ to: 'a@example.com', subject: 's', text: 't' }
		);

		expect(result).toEqual({ status: 'failed', reason: 'HTTP 422' });
		expect(error).toHaveBeenCalledWith('email delivery failed', 422);
	});
});

describe('本文', () => {
	it('確認メールとパスワード再設定メールに URL を含む', () => {
		expect(verificationEmail('https://example.com/v?t=1').text).toContain(
			'https://example.com/v?t=1'
		);
		const reset = resetPasswordEmail('https://example.com/r?t=1');
		expect(reset.text).toContain('https://example.com/r?t=1');
		// 有効期限15分・単回使用は利用者へも明示する。
		expect(reset.text).toContain('15分');
	});
});
