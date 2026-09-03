import type { User, Session } from 'better-auth';
import type { D1Database } from '@cloudflare/workers-types';
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
			};
		}
	}
}

export {};
