<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { locales, localizeHref } from '$lib/paraglide/runtime';
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>
{@render children()}

<div style="display:none">
	{#each locales as locale (locale)}
		<!-- resolve() はルートごとのオーバーロードで型付けされているため、Pathname の
		     ようなユニオンをそのまま渡すと（ルート数が増えた時点で）解決に失敗する。
		     実行時には必ず存在するパスなので、代表の1つへ絞ってから渡す。 -->
		<a href={resolve(localizeHref(page.url.pathname, { locale }) as '/')}>{locale}</a>
	{/each}
</div>
