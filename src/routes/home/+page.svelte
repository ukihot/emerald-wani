<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import { m } from '$lib/paraglide/messages';
	import Turnstile, { resetTurnstile } from '$lib/components/Turnstile.svelte';
	import type { ActionData, PageData } from './$types';
	import { formatDateTime, resultLabel } from '$lib/i18n/match-labels';
	import '../account.css';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head><title>{m.home_page_title()}</title></svelte:head>

<main class="account-shell">
	<p class="eyebrow">{m.home_eyebrow()}</p>
	<h1>{m.app_name()}</h1>

	{#if !data.authenticated}
		<p class="lead">{m.home_intro()}</p>
		{#if form?.message}<p class="error" role="alert">{form.message}</p>{/if}
		<div class="card">
			<h2>{m.home_start_heading()}</h2>
			<p class="lead">{m.home_start_detail()}</p>
			<form
				method="post"
				action="?/playAsGuest"
				use:enhance={() =>
					async ({ update }) => {
						await update();
						// トークンは単回使用。送信のたびに取り直す。
						resetTurnstile();
					}}
			>
				<Turnstile />
				<div class="form-actions">
					<button type="submit" class="primary">{m.home_play_as_guest()}</button>
					<a href={resolve('/login')}>{m.nav_login()}</a>
					<a href={resolve('/signup')}>{m.nav_signup()}</a>
				</div>
			</form>
		</div>
	{:else}
		<p class="lead">
			{data.guest
				? m.home_greeting_guest({ name: data.displayName })
				: m.home_greeting({ name: data.displayName })}
		</p>

		<nav class="account-nav" aria-label={m.nav_menu_label()}>
			<a href={resolve('/play')}>{m.nav_online_match()}</a>
			<a href={resolve('/')}>{m.nav_cpu_practice()}</a>
			<a href={resolve('/history')}>{m.nav_history()}</a>
			{#if data.guest}<a href={resolve('/signup')}>{m.nav_signup()}</a>{/if}
		</nav>

		{#if data.guest}
			<p class="notice">{m.home_guest_notice()}</p>
		{:else if !data.emailVerified}
			<p class="notice">{m.home_unverified_notice()}</p>
		{/if}

		<section class="card">
			<h2>{m.home_record_heading()}</h2>
			<div class="record-grid">
				<div><span>{m.record_total()}</span><strong>{data.record.total}</strong></div>
				<div><span>{m.record_wins()}</span><strong>{data.record.wins}</strong></div>
				<div><span>{m.record_losses()}</span><strong>{data.record.losses}</strong></div>
				<div><span>{m.record_draws()}</span><strong>{data.record.draws}</strong></div>
			</div>
		</section>

		<section class="card">
			<h2>{m.home_recent_heading()}</h2>
			{#if data.recent.length === 0}
				<p class="empty-state">{m.home_no_matches()}</p>
			{:else}
				<ul class="match-list">
					{#each data.recent as item (item.matchId)}
						<li>
							<a href={resolve('/history/[id]', { id: item.matchId })}>
								<span class="result-badge {item.result}">{resultLabel(item.result)}</span>
								<span>{item.score[0]} — {item.score[1]}</span>
								<span class="match-meta">{formatDateTime(item.endedAt)}</span>
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<form method="post" action="?/signOut" use:enhance>
			<div class="form-actions">
				<button type="submit" class="secondary">{m.action_sign_out()}</button>
			</div>
		</form>
	{/if}
</main>
