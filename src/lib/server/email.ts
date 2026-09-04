/**
 * トランザクションメールの配送。
 *
 * better-auth はメール送信機能を持たないため、確認メールとパスワード再設定メールの
 * 実配送はアプリ側で用意する（doc/designs/10-auth-and-access.md、doc/email.md）。
 * MVP の配送業者は **Resend**（Workers から HTTP API で呼べる）を選定した。
 * Cloudflare Email Workers は受信専用であり送信には使えないため採用しない。
 *
 * 鍵が未設定のローカル開発では送信せず、本文をログへ出す（`logged` を返す）。
 * これによりメール配送の資格情報なしでも登録フローを最後まで確認できる。
 * ログに出すのは宛先・件名・URL のみで、トークンそのものは URL の一部としてしか
 * 現れない。**本番でこのフォールバックに落ちることはない**（起動時に鍵を必須化する
 * のではなく、送信失敗として `failed` を返し、呼び出し側が検知できるようにする）。
 */

export interface EmailMessage {
	to: string;
	subject: string;
	text: string;
}

export type EmailDeliveryResult =
	| { status: 'sent'; id: string | null }
	| { status: 'logged' }
	| { status: 'failed'; reason: string };

export interface EmailConfig {
	apiKey?: string;
	from?: string;
	/** 本番・ステージングでフォールバックを禁止する。 */
	requireProvider?: boolean;
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export async function sendEmail(
	config: EmailConfig,
	message: EmailMessage
): Promise<EmailDeliveryResult> {
	if (!config.apiKey || !config.from) {
		if (config.requireProvider) {
			return { status: 'failed', reason: 'email provider is not configured' };
		}
		console.info(`[email:dev] to=${message.to} subject=${message.subject}\n${message.text}`);
		return { status: 'logged' };
	}

	try {
		const response = await fetch(RESEND_ENDPOINT, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${config.apiKey}`,
				'content-type': 'application/json'
			},
			body: JSON.stringify({
				from: config.from,
				to: [message.to],
				subject: message.subject,
				text: message.text
			})
		});
		if (!response.ok) {
			// 応答本文にはメールアドレスが含まれうるため、状態コードだけを記録する
			// （doc/designs/09-api-protocol.md 4節: メールアドレスをログへ出さない）。
			console.error('email delivery failed', response.status);
			return { status: 'failed', reason: `HTTP ${response.status}` };
		}
		const body = (await response.json().catch(() => null)) as { id?: string } | null;
		return { status: 'sent', id: body?.id ?? null };
	} catch (error) {
		console.error('email delivery threw', error instanceof Error ? error.name : 'unknown');
		return { status: 'failed', reason: 'network error' };
	}
}

export function verificationEmail(url: string): Omit<EmailMessage, 'to'> {
	return {
		subject: 'エメラルドワニ｜メールアドレスの確認',
		text: [
			'エメラルドワニへの登録ありがとうございます。',
			'',
			'次のリンクを開くとメールアドレスの確認が完了します。',
			url,
			'',
			'このリンクの有効期限は1時間です。',
			'心当たりがない場合は、このメールを破棄してください。'
		].join('\n')
	};
}

export function resetPasswordEmail(url: string): Omit<EmailMessage, 'to'> {
	return {
		subject: 'エメラルドワニ｜パスワードの再設定',
		text: [
			'パスワード再設定のリクエストを受け付けました。',
			'',
			'次のリンクから新しいパスワードを設定してください。',
			url,
			'',
			'このリンクの有効期限は15分で、1回だけ使用できます。',
			'心当たりがない場合は、このメールを破棄してください。パスワードは変更されません。'
		].join('\n')
	};
}
