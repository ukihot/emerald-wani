import * as v from 'valibot';
import { DeploymentPlacementSchema, GameActionSchema } from './game';

/**
 * WebSocket メッセージの Valibot スキーマ。
 *
 * 設計: doc/designs/09-api-protocol.md 2節、doc/designs/11-security-controls.md 11.5。
 * `v.strictObject` を既定とし、未定義キーは拒否する。
 */

const ActionIdSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(64));
const RevSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

/**
 * MatchRoom が受理する「Command」。1件で `rev` が1増える単位。
 *
 * `GameActionSchema` の `type` は6値の picklist（`v.variant` の判別キーには使えない）
 * のため、判別共用体ではなく `v.union` を使う。ブランチ数が4つと少なく、
 * `strictObject` が余計なキーを即座に弾くため誤判定の実害はない。
 */
export const CommandSchema = v.union([
	v.strictObject({
		type: v.literal('submitDeployment'),
		placements: v.pipe(v.array(DeploymentPlacementSchema), v.maxLength(8))
	}),
	GameActionSchema,
	v.strictObject({ type: v.literal('endTurn') }),
	v.strictObject({ type: v.literal('concede') })
]);
export type Command = v.InferOutput<typeof CommandSchema>;

export const HelloPayloadSchema = v.strictObject({
	ticket: v.pipe(v.string(), v.minLength(1), v.maxLength(2048)),
	lastRev: v.optional(RevSchema)
});

export const ActPayloadSchema = v.strictObject({
	actionId: ActionIdSchema,
	baseRev: RevSchema,
	action: CommandSchema
});

export const ResyncPayloadSchema = v.strictObject({});

/** クライアント → サーバのメッセージ全体。`ping` は Hibernation の auto-response が処理するため含まない。 */
export const ClientMessageSchema = v.variant('t', [
	v.strictObject({ t: v.literal('hello'), ...HelloPayloadSchema.entries }),
	v.strictObject({ t: v.literal('act'), ...ActPayloadSchema.entries }),
	v.strictObject({ t: v.literal('resync') })
]);
export type ClientMessage = v.InferOutput<typeof ClientMessageSchema>;

/** メッセージサイズ上限（doc/designs/11-security-controls.md 11.5）。 */
export const MAX_MESSAGE_BYTES = 8 * 1024;

/** 送信頻度の上限（同一接続、doc/designs/11-security-controls.md 11.2）。 */
export const RATE_LIMIT_MESSAGES = 20;
export const RATE_LIMIT_WINDOW_MS = 10_000;

/** 連続して無効なメッセージを送った場合に切断する閾値。 */
export const MAX_CONSECUTIVE_INVALID = 5;

/** 認証（`hello`）を待つ猶予（doc/designs/07-durable-objects.md 9.2）。 */
export const AUTH_PENDING_TIMEOUT_MS = 5_000;

export type ErrorCode =
	| 'E_MALFORMED'
	| 'E_UNAUTHENTICATED'
	| 'E_FORBIDDEN'
	| 'E_STALE_REV'
	| 'E_WRONG_PHASE'
	| 'E_NOT_YOUR_TURN'
	| 'E_MATCH_FINISHED'
	| 'E_DEPLOYMENT_INVALID'
	| 'E_INSUFFICIENT_VITALITY'
	| 'E_INVALID_MOVE'
	| 'E_INVALID_TARGET'
	| 'E_CELL_OCCUPIED'
	| 'E_ABILITY_UNAVAILABLE'
	| 'E_RATE_LIMITED'
	| 'E_RULE_VERSION_UNSUPPORTED'
	| 'E_INTERNAL';
