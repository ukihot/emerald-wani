<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { locales, localizeHref } from '$lib/paraglide/runtime';
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import SiteFooter from '$lib/components/SiteFooter.svelte';

	let { children } = $props();

	// 盤面を全画面で使う画面ではフッターを出さない。それ以外の画面には必ず出す
	// （規約・ポリシー・窓口への導線を画面ごとに貼り忘れないため）。
	const showFooter = $derived.by(() => {
		const path = page.url.pathname.replace(/^\/(?:ja|en)(?=\/|$)/, '') || '/';
		return !(path === '/' || /^\/(play|online|admin)(\/|$)/.test(path));
	});
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>
{@render children()}
{#if showFooter}<SiteFooter />{/if}

<div style="display:none">
	{#each locales as locale (locale)}
		<!-- resolve() はルートごとのオーバーロードで型付けされているため、Pathname の
		     ようなユニオンをそのまま渡すと（ルート数が増えた時点で）解決に失敗する。
		     実行時には必ず存在するパスなので、代表の1つへ絞ってから渡す。 -->
		<a href={resolve(localizeHref(page.url.pathname, { locale }) as '/')}>{locale}</a>
	{/each}
</div>
