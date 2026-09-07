<script lang="ts">
	import { enhance } from '$app/forms';
	import { m } from '$lib/paraglide/messages';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<section class="card">
	<h2>{m.admin_mfa_heading()}</h2>
	{#if !data.enabled}<p class="notice">{m.admin_mfa_required()}</p>{/if}
	{#if form && 'message' in form && form.message}
		<p class="error" role="alert">{form.message}</p>
	{/if}

	{#if form && 'totpURI' in form && form.totpURI}
		<p class="lead">{m.admin_mfa_uri_label()}</p>
		<p><code>{form.totpURI}</code></p>
		<p class="lead">{m.admin_mfa_backup_label()}</p>
		<ul>
			{#each form.backupCodes ?? [] as code (code)}
				<li><code>{code}</code></li>
			{/each}
		</ul>
		<p class="lead">{m.admin_mfa_verify_intro()}</p>
		<form method="post" action="?/verify" use:enhance>
			<div class="field">
				<label for="code">{m.field_totp_code()}</label>
				<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required />
			</div>
			<div class="form-actions">
				<button type="submit" class="primary">{m.two_factor_submit()}</button>
			</div>
		</form>
	{:else}
		<p class="lead">{m.admin_mfa_intro()}</p>
		<form method="post" action="?/enable" use:enhance>
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
				<button type="submit" class="primary">{m.admin_mfa_enable()}</button>
			</div>
		</form>
	{/if}
</section>
