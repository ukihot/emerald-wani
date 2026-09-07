<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import { m } from '$lib/paraglide/messages';
	import Turnstile, { resetTurnstile } from '$lib/components/Turnstile.svelte';
	import type { ActionData } from './$types';
	import '../account.css';

	let { form }: { form: ActionData } = $props();
</script>

<svelte:head><title>{m.forgot_page_title()}</title></svelte:head>

<main class="account-shell">
	<p class="eyebrow">{m.forgot_eyebrow()}</p>
	<h1>{m.forgot_heading()}</h1>

	{#if form?.sent}
		<p class="notice">{m.forgot_sent_notice()}</p>
	{:else}
		{#if form?.message}<p class="error" role="alert">{form.message}</p>{/if}
		<form
			method="post"
			use:enhance={() =>
				async ({ update }) => {
					await update();
					// トークンは単回使用。送信のたびに取り直す。
					resetTurnstile();
				}}
			class="card"
		>
			<Turnstile />
			<div class="field">
				<label for="email">{m.field_email()}</label>
				<input id="email" name="email" type="email" required autocomplete="email" />
			</div>
			<div class="form-actions">
				<button type="submit" class="primary">{m.forgot_submit()}</button>
				<a href={resolve('/login')}>{m.forgot_back_to_login()}</a>
			</div>
		</form>
	{/if}
</main>
