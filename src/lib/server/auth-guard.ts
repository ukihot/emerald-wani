import { error } from '@sveltejs/kit';

export function requireUser(locals: App.Locals) {
	if (!locals.user || !locals.session) throw error(401, 'Authentication required');
	return { user: locals.user, session: locals.session };
}

export function requireOwner(locals: App.Locals, ownerUserId: string) {
	const identity = requireUser(locals);
	if (identity.user.id !== ownerUserId) throw error(404, 'Not found');
	return identity;
}
