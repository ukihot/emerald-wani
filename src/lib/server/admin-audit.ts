import { error, redirect, type RequestEvent } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth-guard';

/**
 * 管理者の認可と `admin_audit` への記録（doc/designs/10-auth-and-access.md 10.4、
 * doc/designs/14-observability.md 1.4）。
 *
 * 本番・ステージングでは、これに加えて **Cloudflare Access によるネットワーク層の
 * 制限が必須**である（アプリ層の認可だけを管理画面の防御にしない）。
 */

/** 管理画面に入れる役割。役割の付与は D1 を直接更新して行う（画面からは配らない）。 */
const ADMIN_ROLES = ['admin', 'moderator'];

export interface AdminIdentity {
	userId: string;
	role: string;
}

/**
 * 管理者であることを確認する。管理者でなければ **404**（403 ではない）。
 * 管理画面の存在自体を一般利用者に知らせない（doc/designs/10-auth-and-access.md 10.3）。
 *
 * MFA 未設定の管理者は `/admin/mfa` へ送る（10.4「未設定の管理者は管理画面に入れない」）。
 */
export function requireAdmin(event: RequestEvent, { allowWithoutMfa = false } = {}): AdminIdentity {
	const { user } = requireUser(event.locals);
	const role = (user as { role?: string }).role ?? 'user';
	if (!ADMIN_ROLES.includes(role)) throw error(404, 'Not found');

	if (!allowWithoutMfa && !(user as { twoFactorEnabled?: boolean }).twoFactorEnabled) {
		throw redirect(303, '/admin/mfa');
	}
	return { userId: user.id, role };
}

/** 運営操作を1件記録する。**追記専用**（更新・削除の手段は用意しない）。 */
export async function recordAdminAudit(
	event: RequestEvent,
	entry: {
		adminUserId: string;
		action: string;
		targetType?: string | null;
		targetId?: string | null;
		detail?: Record<string, unknown>;
	}
): Promise<void> {
	const db = event.platform?.env?.DB;
	if (!db) return;
	try {
		await db
			.prepare(
				`INSERT INTO admin_audit (id, ts, admin_user_id, action, target_type, target_id, detail_json)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				crypto.randomUUID(),
				Date.now(),
				entry.adminUserId,
				entry.action,
				entry.targetType ?? null,
				entry.targetId ?? null,
				JSON.stringify(entry.detail ?? {})
			)
			.run();
	} catch (cause) {
		console.error('admin_audit insert failed', entry.action, cause);
	}
}
