<script lang="ts">
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages';
	import { endReasonLabel, formatDateTime, resultLabel } from '$lib/i18n/match-labels';
	import type { PageData } from './$types';
	import '../account.css';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>{m.history_page_title()}</title></svelte:head>

<main class="account-shell">
	<p class="eyebrow">{m.history_eyebrow()}</p>
	<h1>{m.history_heading()}</h1>

	<nav class="account-nav" aria-label={m.nav_menu_label()}>
		<a href={resolve('/home')}>{m.nav_home()}</a>
		<a href={resolve('/play')}>{m.nav_online_match()}</a>
	</nav>

	{#if data.matches.length === 0}
		<p class="empty-state">{m.history_empty()}</p>
	{:else}
		<ul class="match-list">
			{#each data.matches as item (item.matchId)}
				<li>
					<a href={resolve('/history/[id]', { id: item.matchId })}>
						<span class="result-badge {item.result}">{resultLabel(item.result)}</span>
						<span>
							{item.score[0]} — {item.score[1]}
							<span class="match-meta">
								{endReasonLabel(item.endReason)} ·
								{m.history_rounds({ count: item.roundCount })} ·
								{item.replayAvailable ? m.history_replay_available() : m.history_replay_pending()}
							</span>
						</span>
						<span class="match-meta">{formatDateTime(item.endedAt)}</span>
					</a>
				</li>
			{/each}
		</ul>

		{#if data.nextCursor}
			<!-- 次ページはカーソルをクエリ文字列で渡す。`resolve` はパスだけを解決するため、
			     リンクではなく GET フォームにしてクエリの組み立てをブラウザに任せる。 -->
			<form method="get" action={resolve('/history')} class="form-actions">
				<input type="hidden" name="cursor" value={data.nextCursor} />
				<button type="submit" class="secondary">{m.history_load_more()}</button>
			</form>
		{/if}
	{/if}
</main>
