const webOrigin = process.env.EMERALD_WEB_ORIGIN ?? 'http://localhost:5173';
const realtimeOrigin = process.env.EMERALD_REALTIME_ORIGIN ?? 'http://127.0.0.1:8787';

async function expectOk(response, label) {
	if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
	return response;
}

const health = await expectOk(await fetch(`${realtimeOrigin}/health`), 'realtime health');
const healthBody = await health.json();
if (healthBody.ok !== true || healthBody.worker !== 'emerald-wani-realtime') {
	throw new Error('realtime health: unexpected payload');
}

await expectOk(await fetch(webOrigin), 'web root');

const guest = await expectOk(
	await fetch(`${webOrigin}/api/auth/sign-in/anonymous`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: '{}'
	}),
	'guest sign-in'
);
const guestBody = await guest.json();
if (guestBody.user?.isAnonymous !== true || typeof guestBody.user?.id !== 'string') {
	throw new Error('guest sign-in: anonymous user was not issued');
}

const setCookie = guest.headers.get('set-cookie');
const cookie = setCookie?.split(';', 1)[0];
if (!cookie) throw new Error('guest sign-in: session cookie was not issued');

const session = await expectOk(
	await fetch(`${webOrigin}/api/auth/get-session`, { headers: { cookie } }),
	'guest session'
);
const sessionBody = await session.json();
if (sessionBody.user?.id !== guestBody.user.id) {
	throw new Error('guest session: issued user and session user differ');
}

console.log('phase0 smoke: web=ok realtime=ok anonymous-session=ok');
