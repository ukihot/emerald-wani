<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import { m } from '$lib/paraglide/messages';
	import type { ActionData } from './$types';
	import '../account.css';

	let { form }: { form: ActionData } = $props();
</script>

<svelte:head><title>{m.login_page_title()}</title></svelte:head>

<main class="account-shell">
	<p class="eyebrow">{m.login_eyebrow()}</p>
	<h1>{m.login_heading()}</h1>

	{#if form?.message}<p class="error" role="alert">{form.message}</p>{/if}

	<form method="post" use:enhance class="card">
		<div class="field">
			<label for="email">{m.field_email()}</label>
			<input
				id="email"
				name="email"
				type="email"
				required
				autocomplete="email"
				value={form?.email ?? ''}
			/>
		</div>
		<div class="field">
			<label for="password">{m.field_password()}</label>
			<input
				id="password"
				name="password"
				type="password"
				required
				autocomplete="current-password"
			/>
		</div>
		<div class="form-actions">
			<button type="submit" class="primary">{m.login_submit()}</button>
			<a href={resolve('/forgot-password')}>{m.login_forgot_password()}</a>
			<a href={resolve('/signup')}>{m.nav_signup()}</a>
		</div>
	</form>
</main>
