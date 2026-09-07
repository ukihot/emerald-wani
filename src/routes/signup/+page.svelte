<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import { m } from '$lib/paraglide/messages';
	import Turnstile, { resetTurnstile } from '$lib/components/Turnstile.svelte';
	import type { ActionData, PageData } from './$types';
	import '../account.css';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head><title>{m.signup_page_title()}</title></svelte:head>

<main class="account-shell">
	<p class="eyebrow">{m.signup_eyebrow()}</p>
	<h1>{m.signup_heading()}</h1>
	<p class="lead">{m.signup_lead()}</p>

	{#if data.guest}
		<p class="notice">{m.signup_guest_notice()}</p>
	{/if}

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
			<label for="name">{m.field_display_name()}</label>
			<input
				id="name"
				name="name"
				required
				maxlength="24"
				value={form && 'name' in form ? form.name : data.suggestedName}
			/>
		</div>
		<div class="field">
			<label for="email">{m.field_email()}</label>
			<input
				id="email"
				name="email"
				type="email"
				required
				autocomplete="email"
				value={form && 'email' in form ? form.email : ''}
			/>
			<small>{m.signup_email_help()}</small>
		</div>
		<div class="field">
			<label for="password">{m.field_password()}</label>
			<input
				id="password"
				name="password"
				type="password"
				required
				minlength={data.minPasswordLength}
				autocomplete="new-password"
			/>
			<small>{m.signup_password_help({ min: data.minPasswordLength })}</small>
		</div>
		<div class="form-actions">
			<button type="submit" class="primary">{m.signup_submit()}</button>
			<a href={resolve('/login')}>{m.signup_have_account()}</a>
		</div>
	</form>
</main>
