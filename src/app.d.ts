import type { User, Session } from 'better-auth';
import type { D1Database, DurableObjectNamespace, R2Bucket } from '@cloudflare/workers-types';
import { createAuth } from '$lib/server/auth';

// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		interface Locals {
			user?: User;
			session?: Session;
			auth: ReturnType<typeof createAuth>;
		}

		// interface Error {}
		// interface PageData {}
		// interface PageState {}
		interface Platform {
			env: {
				DB: D1Database;
				ORIGIN: string;
				/** リプレイの R2。書き込むのは realtime Worker だけで、web は読むだけ。 */
				REPLAYS: R2Bucket;
				/**
				 * realtime Worker の DO は `script_name` 越しの参照のため、生成される型は
				 * 汎用の DurableObjectNamespace になる（doc/designs/02-architecture.md 3.2）。
				 */
				MATCH_ROOM: DurableObjectNamespace;
				MATCH_QUEUE: DurableObjectNamespace;
				GUEST_GUARD: DurableObjectNamespace;
				/** WSチケット署名鍵（kid付き複数世代）。doc/designs/13-secrets-lifecycle.md S-01。 */
				WS_TICKET_SECRET_V1: string;
			};
		}
	}
}

export {};
