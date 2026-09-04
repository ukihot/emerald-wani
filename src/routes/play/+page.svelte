<script lang="ts">
	import { onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages';
	import '../game.css';

	type Status = 'idle' | 'waiting' | 'matched' | 'error';

	let status = $state<Status>('idle');
	let errorMessage = $state('');
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	async function enqueue() {
		errorMessage = '';
		status = 'waiting';
		try {
			const response = await fetch('/api/v1/matchmaking/enqueue', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ requestId: crypto.randomUUID() })
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			startPolling();
		} catch {
			status = 'error';
			errorMessage = m.play_enqueue_failed();
		}
	}

	function startPolling() {
		stopPolling();
		pollTimer = setInterval(pollStatus, 1000);
		void pollStatus();
	}

	function stopPolling() {
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = null;
	}

	async function pollStatus() {
		try {
			const response = await fetch('/api/v1/matchmaking/status');
			if (!response.ok) return;
			const body = (await response.json()) as { status: string; matchId?: string };
			if (body.status === 'matched' && body.matchId) {
				stopPolling();
				status = 'matched';
				await goto(resolve('/online/[id]', { id: body.matchId }));
			}
		} catch {
			/* 次のポーリングで再試行する */
		}
	}

	async function cancel() {
		stopPolling();
		status = 'idle';
		try {
			await fetch('/api/v1/matchmaking', { method: 'DELETE' });
		} catch {
			/* キャンセルは失敗しても致命的ではない */
		}
	}

	onDestroy(stopPolling);
</script>

<svelte:head>
	<title>{m.play_page_title()}</title>
</svelte:head>

<main class="lobby-shell">
	<h1>{m.play_heading()}</h1>
	<p class="tagline">{m.play_lead()}</p>

	{#if status === 'idle'}
		<button type="button" class="primary" onclick={enqueue}>{m.play_find_opponent()}</button>
	{:else if status === 'waiting'}
		<div class="waiting">
			<span class="spinner" aria-hidden="true"></span>
			<p>{m.play_searching()}</p>
			<button type="button" class="secondary" onclick={cancel}>{m.play_cancel()}</button>
		</div>
	{:else if status === 'matched'}
		<p>{m.play_matched()}</p>
	{:else if status === 'error'}
		<p class="error" role="alert">{errorMessage}</p>
		<button type="button" class="primary" onclick={enqueue}>{m.play_retry()}</button>
	{/if}
</main>

<style>
	.lobby-shell {
		max-width: 32rem;
		margin: 4rem auto;
		padding: 2rem;
		text-align: center;
		display: grid;
		gap: 1.5rem;
	}
	.waiting {
		display: grid;
		gap: 1rem;
		justify-items: center;
	}
	.spinner {
		width: 2rem;
		height: 2rem;
		border-radius: 50%;
		border: 3px solid #4a4e4e;
		border-top-color: #42e59b;
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
