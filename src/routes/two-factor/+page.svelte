<script lang="ts">
	import { enhance } from '$app/forms';
	import { m } from '$lib/paraglide/messages';
	import type { ActionData } from './$types';
	import '../account.css';

	let { form }: { form: ActionData } = $props();
</script>

<svelte:head><title>{m.two_factor_page_title()}</title></svelte:head>

<main class="account-shell">
	<h1>{m.two_factor_heading()}</h1>
	{#if form?.message}<p class="error" role="alert">{form.message}</p>{/if}
	<form method="post" use:enhance class="card">
		<p class="lead">{m.two_factor_description()}</p>
		<div class="field">
			<label for="code">{m.field_totp_code()}</label>
			<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required />
		</div>
		<div class="form-actions">
			<button type="submit" class="primary">{m.two_factor_submit()}</button>
		</div>
	</form>
</main>
