<script lang="ts">
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages';
	import '../account.css';

	let { children } = $props();
</script>

<svelte:head><title>{m.admin_page_title()}</title></svelte:head>

<main class="account-shell">
	<p class="eyebrow">{m.admin_heading()}</p>
	<p class="notice">{m.admin_audit_notice()}</p>
	<nav class="account-nav" aria-label={m.admin_heading()}>
		<a href={resolve('/admin')}>{m.admin_heading()}</a>
		<a href={resolve('/admin/mfa')}>{m.admin_mfa_heading()}</a>
	</nav>
	{@render children()}
</main>
