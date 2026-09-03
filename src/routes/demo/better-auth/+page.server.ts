import { redirect } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth-guard';
import type { Actions } from './$types';
import type { PageServerLoad } from './$types';

export const load = ((event) => {
	if (!event.locals.user) {
		return redirect(302, '/demo/better-auth/login');
	}
	return { user: requireUser(event.locals).user };
}) satisfies PageServerLoad;

export const actions = {
	signOut: async (event) => {
		const { auth } = event.locals;

		await auth.api.signOut({
			headers: event.request.headers
		});
		return redirect(302, '/demo/better-auth/login');
	}
} satisfies Actions;
