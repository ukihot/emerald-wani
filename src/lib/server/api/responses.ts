import { json } from '@sveltejs/kit';
import type { ErrorCode } from '$lib/protocol/ws';

/**
 * REST のエラー応答を統一する。
 * doc/designs/11-security-controls.md 11.7: `{ error: { code, message } }` のみを返し、
 * スタックトレースや内部情報を含めない。
 */
export function errorResponse(status: number, code: ErrorCode | 'E_NOT_FOUND', message: string) {
	return json({ error: { code, message } }, { status });
}
