<script module lang="ts">
	interface TurnstileApi {
		render(el: HTMLElement, options: Record<string, unknown>): string;
		reset(widgetId?: string): void;
	}

	/**
	 * 送信のたびにトークンは使い切られる。フォームの結果を反映したあとに呼んで
	 * ウィジェットを取り直す（use:enhance のコールバックから使う）。
	 */
	export function resetTurnstile(): void {
		(globalThis as { turnstile?: TurnstileApi }).turnstile?.reset();
	}

	let scriptPromise: Promise<void> | null = null;

	function loadScript(): Promise<void> {
		if ((globalThis as { turnstile?: TurnstileApi }).turnstile) return Promise.resolve();
		scriptPromise ??= new Promise<void>((resolve, reject) => {
			const script = document.createElement('script');
			script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
			script.async = true;
			script.onload = () => resolve();
			script.onerror = () => reject(new Error('turnstile script failed to load'));
			document.head.append(script);
		});
		return scriptPromise;
	}
</script>

<script lang="ts">
	import { env } from '$env/dynamic/public';

	/**
	 * Turnstile ウィジェット（Managed モード）。
	 *
	 * サイトキーが未設定のローカル開発では何も描画しない。サーバ側の検証も同じ条件で
	 * 飛ばす（$lib/server/turnstile.ts）。明示レンダリングを使うのは、SvelteKit の
	 * クライアント遷移では api.js の暗黙スキャンが再実行されないため。
	 */
	const siteKey = env.PUBLIC_TURNSTILE_SITE_KEY ?? '';

	let host = $state<HTMLDivElement | null>(null);

	$effect(() => {
		const el = host;
		if (!siteKey || !el) return;
		let disposed = false;
		loadScript()
			.then(() => {
				if (disposed) return;
				const api = (globalThis as { turnstile?: TurnstileApi }).turnstile;
				api?.render(el, { sitekey: siteKey, action: 'form', theme: 'auto' });
			})
			.catch((error) => console.error(error));
		return () => {
			disposed = true;
		};
	});
</script>

{#if siteKey}
	<div class="turnstile" bind:this={host}></div>
{/if}
