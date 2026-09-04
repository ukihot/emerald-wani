<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import { m } from '$lib/paraglide/messages';
	import type { ActionData, PageData } from './$types';
	import '../account.css';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head><title>{m.reset_page_title()}</title></svelte:head>

<main class="account-shell">
	<p class="eyebrow">{m.forgot_eyebrow()}</p>
	<h1>{m.reset_heading()}</h1>

	{#if data.invalidToken}
		<p class="error" role="alert">{m.reset_invalid_token()}</p>
		<p><a href={resolve('/forgot-password')}>{m.reset_restart()}</a></p>
	{:else}
		{#if form?.message}<p class="error" role="alert">{form.message}</p>{/if}
		<form method="post" use:enhance class="card">
			<input type="hidden" name="token" value={data.token} />
			<div class="field">
				<label for="password">{m.field_new_password()}</label>
				<input
					id="password"
					name="password"
					type="password"
					required
					minlength={data.minPasswordLength}
					autocomplete="new-password"
				/>
				<small>{m.reset_password_help({ min: data.minPasswordLength })}</small>
			</div>
			<div class="form-actions">
				<button type="submit" class="primary">{m.reset_submit()}</button>
			</div>
		</form>
	{/if}
</main>
