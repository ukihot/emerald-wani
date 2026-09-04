<script lang="ts">
	import { resolve } from '$app/paths';
	import { enhance } from '$app/forms';
	import { m } from '$lib/paraglide/messages';
	import { REPORT_REASONS } from '$lib/protocol/report';
	import { parseReplay, type Replay } from '$lib/protocol/replay';
	import {
		endReasonLabel,
		formatDateTimeLong,
		reportReasonLabel,
		resultLabel
	} from '$lib/i18n/match-labels';
	import type { ActionData, PageData } from './$types';
	import '../../account.css';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let replay = $state<Replay | null>(null);
	let replayState = $state<'idle' | 'loading' | 'pending' | 'error'>('idle');

	/**
	 * リプレイは gzip した NDJSON で配信される。`fetch` は `Content-Encoding` を見て
	 * 自動で展開するため、ここでは本文をそのまま NDJSON として読む。
	 */
	async function loadReplay() {
		replayState = 'loading';
		try {
			const response = await fetch(`/api/v1/matches/${data.match.matchId}/replay`);
			if (response.status === 202) {
				replayState = 'pending';
				return;
			}
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			replay = parseReplay(await response.text());
			replayState = 'idle';
		} catch (error) {
			console.error(error);
			replayState = 'error';
		}
	}

	function actorLabel(actorSeat: number | null): string {
		if (actorSeat === null) return m.seat_system();
		return actorSeat === data.match.seat ? m.seat_you() : m.seat_opponent();
	}
</script>

<svelte:head><title>{m.match_page_title()}</title></svelte:head>

<main class="account-shell">
	<p class="eyebrow">{m.match_eyebrow()}</p>
	<h1>{m.match_heading()}</h1>

	<nav class="account-nav" aria-label={m.nav_menu_label()}>
		<a href={resolve('/history')}>{m.nav_history()}</a>
		<a href={resolve('/home')}>{m.nav_home()}</a>
	</nav>

	<section class="card">
		<h2>
			<span class="result-badge {data.match.result}">{resultLabel(data.match.result)}</span>
		</h2>
		<div class="record-grid">
			<div><span>{m.seat_you()}</span><strong>{data.match.score[data.match.seat]}</strong></div>
			<div>
				<span>{m.seat_opponent()}</span>
				<strong>{data.match.score[data.match.seat === 0 ? 1 : 0]}</strong>
			</div>
			<div>
				<span>{m.match_rounds_label()}</span><strong>{data.match.roundCount}</strong>
			</div>
		</div>
		<p class="match-meta">
			{m.match_versus({
				name: data.match.opponent?.displayName ?? m.match_unknown_opponent()
			})} ·
			{endReasonLabel(data.match.endReason)} ·
			{formatDateTimeLong(data.match.endedAt)}
		</p>
		<p class="match-meta">
			{m.match_versions({
				ruleVersion: data.match.ruleVersion,
				mapVersion: data.match.mapVersion,
				seed: data.match.mapSeed
			})}
		</p>
	</section>

	<section class="card">
		<h2>{m.replay_heading()}</h2>
		{#if !data.match.replayAvailable}
			<p class="empty-state">{m.replay_not_ready()}</p>
		{:else if replay}
			<p class="match-meta">
				{m.replay_moves({ count: replay.entries.length })} ·
				{replay.header.firstSeat === data.match.seat
					? m.replay_first_seat_you()
					: m.replay_first_seat_opponent()}
			</p>
			<ol class="replay-log">
				{#each replay.entries as entry (entry.rev)}
					<li>
						<span class="rev">{entry.rev}</span>
						<span class="actor" class:mine={entry.actorSeat === data.match.seat}>
							{actorLabel(entry.actorSeat)}
						</span>
						<span>
							<!-- ルールエンジンが出す文言はリプレイに永続化された版数付きデータで、
							     翻訳の対象にしない（src/lib/i18n/match-labels.ts の注記を参照）。 -->
							{#if entry.events.length > 0}
								{entry.events.map((event) => event.message).join(' / ')}
							{:else}
								{String(entry.command.type ?? '')}
							{/if}
						</span>
					</li>
				{/each}
			</ol>
		{:else}
			<div class="form-actions">
				<button
					type="button"
					class="primary"
					onclick={loadReplay}
					disabled={replayState === 'loading'}
				>
					{replayState === 'loading' ? m.replay_loading() : m.replay_show()}
				</button>
			</div>
			{#if replayState === 'pending'}
				<p class="empty-state">{m.replay_pending()}</p>
			{:else if replayState === 'error'}
				<p class="error" role="alert">{m.replay_load_failed()}</p>
			{/if}
		{/if}
	</section>

	{#if data.match.opponent}
		<section class="card">
			<h2>{m.report_heading()}</h2>
			{#if form?.reported}
				<p class="notice">{m.report_received()}</p>
			{:else}
				<p class="lead">{m.report_lead()}</p>
				{#if form?.message}<p class="error" role="alert">{form.message}</p>{/if}
				<form method="post" action="?/report" use:enhance>
					<input type="hidden" name="targetSeat" value={data.match.opponent.seat} />
					<div class="field">
						<label for="reason">{m.report_reason_label()}</label>
						<select id="reason" name="reason" required>
							{#each REPORT_REASONS as reason (reason)}
								<option value={reason}>{reportReasonLabel(reason)}</option>
							{/each}
						</select>
					</div>
					<div class="form-actions">
						<button type="submit" class="secondary danger">{m.report_submit()}</button>
					</div>
				</form>
			{/if}
		</section>
	{/if}
</main>

<style>
	select {
		min-height: 44px;
		padding: 8px 12px;
		border: 1px solid #24362d;
		background: #050d09;
		color: #e8eee9;
		font: inherit;
	}
</style>
