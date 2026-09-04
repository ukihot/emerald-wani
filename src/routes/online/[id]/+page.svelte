<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import {
		CROCODILES,
		cellId,
		definitionFor,
		actionForCell as findActionForCell,
		getCellById,
		legalActionsForPiece,
		pieceAtCell,
		type Crocodile,
		type CrocodileKind,
		type DeploymentPlacement,
		type GameAction
	} from '$lib/game';
	import { WsClient } from '$lib/client/ws-client.svelte';
	import { m } from '$lib/paraglide/messages';
	import { terrainLabel } from '$lib/i18n/match-labels';
	import '../../game.css';

	const matchId = page.params.id ?? '';
	const client = new WsClient();

	let deployment = $state<Partial<Record<CrocodileKind, string>>>({});
	let selectedKind = $state<CrocodileKind | null>('nushi');
	let selectedPieceId = $state<string | null>(null);
	let submitting = $state(false);
	let now = $state(Date.now());

	const seat = $derived(client.seat);
	const view = $derived(client.view);
	const mySeat = $derived(seat ?? 0);
	const opponentSeat = $derived(mySeat === 0 ? 1 : 0);
	const legalActions = $derived(
		view && selectedPieceId ? legalActionsForPiece(view, selectedPieceId) : ([] as GameAction[])
	);
	const remainingMs = $derived(
		view?.phase === 'deployment'
			? (client.deadlines.deploymentEndsAt ?? 0) - now
			: (client.deadlines.turnEndsAt ?? 0) - now
	);

	async function fetchTicket(): Promise<string> {
		const response = await fetch(`/api/v1/matches/${matchId}/ws-ticket`, { method: 'POST' });
		if (!response.ok) throw new Error(`ws-ticket HTTP ${response.status}`);
		const body = (await response.json()) as { ticket: string };
		return body.ticket;
	}

	onMount(() => {
		void client.connect(matchId, fetchTicket);
		const clock = setInterval(() => {
			now = Date.now();
		}, 250);
		return () => clearInterval(clock);
	});

	onDestroy(() => client.disconnect());

	function draftKindAt(targetCellId: string): CrocodileKind | undefined {
		return (Object.entries(deployment) as [CrocodileKind, string][]).find(
			([, occupied]) => occupied === targetCellId
		)?.[0];
	}

	function boardPiece(targetCellId: string): Crocodile | undefined {
		return view && view.phase !== 'deployment' ? pieceAtCell(view, targetCellId) : undefined;
	}

	function actionForCell(targetCellId: string): GameAction | undefined {
		if (!view) return undefined;
		const occupant = pieceAtCell(view, targetCellId);
		return findActionForCell(legalActions, targetCellId, occupant?.id);
	}

	function placeDeployment(targetCellId: string) {
		if (!view || view.phase !== 'deployment' || !selectedKind) return;
		const cell = getCellById(view.board, targetCellId);
		if (
			!cell ||
			cell.zone !== homeZoneName() ||
			cell.terrain === 'nest' ||
			cell.terrain === 'tree'
		) {
			return;
		}
		const next = { ...deployment };
		for (const [kind, occupied] of Object.entries(next)) {
			if (occupied === targetCellId) delete next[kind as CrocodileKind];
		}
		next[selectedKind] = targetCellId;
		deployment = next;
		selectedKind = CROCODILES.find((definition) => !deployment[definition.kind])?.kind ?? null;
	}

	function homeZoneName(): 'south' | 'north' {
		return mySeat === 0 ? 'south' : 'north';
	}

	function toggleDeployment(kind: CrocodileKind) {
		if (deployment[kind]) {
			const next = { ...deployment };
			delete next[kind];
			deployment = next;
		}
		selectedKind = kind;
	}

	async function confirmDeployment() {
		const placements = CROCODILES.flatMap<DeploymentPlacement>((definition) => {
			const target = deployment[definition.kind];
			return target ? [{ kind: definition.kind, cellId: target }] : [];
		});
		if (placements.length !== 8) return;
		submitting = true;
		try {
			await client.sendAction({ type: 'submitDeployment', placements });
		} catch {
			/* エラーは client.lastError に反映される */
		} finally {
			submitting = false;
		}
	}

	function selectOrAct(targetCellId: string) {
		if (!view) return;
		if (view.phase === 'deployment') {
			placeDeployment(targetCellId);
			return;
		}
		if (view.phase !== 'playing' || view.activeSeat !== mySeat || submitting) return;
		const targetAction = actionForCell(targetCellId);
		if (targetAction) {
			void executeAction(targetAction);
			return;
		}
		const occupant = pieceAtCell(view, targetCellId);
		selectedPieceId = occupant?.owner === mySeat ? occupant.id : null;
	}

	async function executeAction(candidate: GameAction) {
		submitting = true;
		try {
			// cost/label はサーバの Valibot スキーマが未定義キーとして拒否するため送らない
			// （doc/designs/11-security-controls.md 11.5）。
			await client.sendAction({
				type: candidate.type,
				pieceId: candidate.pieceId,
				...(candidate.toCellId ? { toCellId: candidate.toCellId } : {}),
				...(candidate.targetPieceId ? { targetPieceId: candidate.targetPieceId } : {}),
				...(candidate.remote ? { remote: candidate.remote } : {})
			});
			selectedPieceId = null;
		} catch {
			/* エラーは client.lastError に反映される */
		} finally {
			submitting = false;
		}
	}

	async function finishTurn() {
		submitting = true;
		try {
			await client.sendAction({ type: 'endTurn' });
			selectedPieceId = null;
		} catch {
			/* noop */
		} finally {
			submitting = false;
		}
	}

	async function resign() {
		try {
			await client.sendAction({ type: 'concede' });
		} catch {
			/* noop */
		}
	}

	function cellLabel(targetCellId: string): string {
		if (!view) return targetCellId;
		const cell = getCellById(view.board, targetCellId);
		if (!cell) return targetCellId;
		const occupant = boardPiece(targetCellId);
		const draft = draftKindAt(targetCellId);
		// ワニの名前はルールエンジンの版数付きデータなので翻訳しない
		// （src/lib/i18n/match-labels.ts の注記を参照）。
		const name = occupant
			? definitionFor(occupant.kind).name
			: draft
				? definitionFor(draft).name
				: m.board_cell_empty();
		return m.board_cell_label({
			column: cell.x + 1,
			row: cell.y + 1,
			terrain: terrainLabel(cell.terrain),
			occupant: name
		});
	}

	function actionDestination(candidate: GameAction): string {
		if (!view) return '';
		if (candidate.type === 'feed') return m.action_destination_here();
		const target = candidate.targetPieceId ? view.pieces[candidate.targetPieceId] : null;
		const destination = candidate.toCellId ?? (target?.position ? cellId(target.position) : '');
		return destination ? m.action_destination_to({ cell: destination }) : '';
	}

	function clockLabel(): string {
		if (!Number.isFinite(remainingMs)) return '--:--';
		const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
		return `00:${String(seconds).padStart(2, '0')}`;
	}
</script>

<svelte:head>
	<title>{m.online_page_title()}</title>
</svelte:head>

<main class="game-shell">
	<header class="topbar">
		<div>
			<p class="eyebrow">{m.online_eyebrow()}</p>
			<h1>{m.app_name_head()}<span>{m.app_name_tail()}</span></h1>
			<p class="tagline">
				{client.status === 'open'
					? m.online_status_open()
					: client.status === 'reconnecting'
						? m.online_status_reconnecting()
						: client.status === 'connecting'
							? m.online_status_connecting()
							: m.online_status_closed()}
				{#if !client.opponentConnected}{m.online_opponent_disconnected()}{/if}
			</p>
		</div>
	</header>

	{#if !view}
		<p class="mission-card">{m.online_loading()}</p>
	{:else}
		<section class="score-strip" aria-label={m.score_strip_label()}>
			<div class="side-score enemy">
				<span>{m.seat_opponent()}</span><strong
					>{view.score[opponentSeat]}<small>{m.score_suffix()}</small></strong
				>
			</div>
			<div class="turn-status">
				<i class:live={view.phase === 'playing'}></i>
				<strong>
					{view.phase === 'deployment'
						? m.phase_deployment()
						: view.phase === 'finished'
							? m.phase_finished()
							: view.activeSeat === mySeat
								? m.phase_your_turn()
								: m.phase_opponent_turn()}
				</strong>
				<small>{m.round_only({ round: view.round })}</small>
			</div>
			<div class="side-score player">
				<span>{m.seat_you()}</span><strong
					>{view.score[mySeat]}<small>{m.score_suffix()}</small></strong
				>
			</div>
		</section>

		<div class="play-layout">
			<section class="board-column" aria-label={m.board_region_label()}>
				<div class="board" style={`--columns: ${view.board.width}`}>
					{#each view.board.cells as cell (cell.id)}
						{@const piece = boardPiece(cell.id)}
						{@const draftKind = draftKindAt(cell.id)}
						{@const targetAction = actionForCell(cell.id)}
						<button
							type="button"
							class:swamp={cell.terrain === 'swamp'}
							class:tree={cell.terrain === 'tree'}
							class:void={cell.terrain === 'void'}
							class:nest={cell.terrain === 'nest'}
							class:neutral={cell.zone === 'neutral'}
							class:home={cell.zone === homeZoneName()}
							class:legal={Boolean(targetAction)}
							class:selected={piece?.id === selectedPieceId}
							disabled={cell.terrain === 'void'}
							class:deployable={view.phase === 'deployment' &&
								cell.zone === homeZoneName() &&
								cell.terrain !== 'nest'}
							onclick={() => selectOrAct(cell.id)}
							aria-label={cellLabel(cell.id)}
						>
							<span class="coordinates">{cell.x + 1}.{cell.y + 1}</span>
							{#if cell.terrain === 'tree'}<span class="terrain-icon tree-icon">♠</span>
							{:else if cell.terrain === 'swamp'}<span class="terrain-icon">≋</span>
							{:else if cell.terrain === 'nest'}<span class="terrain-icon">⌂</span>{/if}
							{#if piece}
								<span class:ours={piece.owner === mySeat} class="croc">
									<b>{definitionFor(piece.kind).shortName}</b>
									<small
										>{piece.owner === mySeat ? m.board_label_you() : m.board_label_enemy()}</small
									>
								</span>
							{:else if draftKind}
								<span class="croc ours draft"
									><b>{definitionFor(draftKind).shortName}</b><small>{m.board_draft_badge()}</small
									></span
								>
							{/if}
							{#if targetAction}<span class="action-hint">{targetAction.cost}</span>{/if}
						</button>
					{/each}
				</div>

				<div class="vitality-bar">
					<div>
						<span>{m.panel_vitality()}</span>
						<div class="pips">
							<i class:filled={view.vitality[mySeat] >= 1}></i><i
								class:filled={view.vitality[mySeat] >= 2}
							></i>
						</div>
					</div>
					<div class:urgent={remainingMs <= 10_000} class="clock">
						<span>{m.panel_time()}</span><strong>{clockLabel()}</strong>
					</div>
				</div>

				{#if client.lastError}<p class="error" role="alert">{client.lastError.message}</p>{/if}

				<div class="main-actions">
					{#if view.phase === 'deployment'}
						<button
							type="button"
							class="primary"
							disabled={Object.keys(deployment).length !== 8 || submitting}
							onclick={confirmDeployment}
							>{m.action_confirm_deployment({ placed: Object.keys(deployment).length })}</button
						>
					{:else if view.phase === 'playing'}
						<button type="button" class="secondary danger" onclick={resign}
							>{m.action_resign()}</button
						>
						<button
							type="button"
							class="primary"
							disabled={view.activeSeat !== mySeat || submitting}
							onclick={finishTurn}>{m.action_end_turn()}</button
						>
					{/if}
				</div>
			</section>

			<aside class="panel command-panel">
				<div class="panel-heading">
					<span>02</span>
					<div>
						<p>{m.panel_command_eyebrow()}</p>
						<h2>
							{view.phase === 'deployment'
								? m.panel_command_deployment()
								: m.panel_command_playing()}
						</h2>
					</div>
				</div>
				{#if view.phase === 'deployment'}
					<div class="roster">
						{#each CROCODILES as definition (definition.kind)}
							<button
								type="button"
								class:active={selectedKind === definition.kind}
								class:placed={Boolean(deployment[definition.kind])}
								onclick={() => toggleDeployment(definition.kind)}
							>
								<span>{definition.shortName}</span>
								<div><strong>{definition.name}</strong><small>{definition.description}</small></div>
								<em>{definition.points}P</em>
							</button>
						{/each}
					</div>
				{:else if selectedPieceId && view.pieces[selectedPieceId]}
					<div class="legal-list">
						{#each legalActions as candidate, index (`${candidate.type}:${candidate.toCellId}:${candidate.targetPieceId}:${index}`)}
							<button type="button" onclick={() => executeAction(candidate)} disabled={submitting}
								><span>{candidate.cost}</span>
								<div>
									<strong>{candidate.label}</strong><small>{actionDestination(candidate)}</small>
								</div></button
							>
						{:else}<p class="empty-state">{m.no_legal_actions()}</p>{/each}
					</div>
				{:else}
					<div class="select-prompt">
						<span>⌖</span><strong>{m.select_prompt_title()}</strong>
					</div>
				{/if}

				<div class="event-log">
					<p>{m.panel_field_log()}</p>
					<ol>
						{#each client.log as message, index (`${index}:${message}`)}<li
								class:latest={index === 0}
							>
								{message}
							</li>{/each}
					</ol>
				</div>
			</aside>
		</div>

		{#if client.finished}
			<div class="result-backdrop">
				<section class="result-card" aria-live="assertive">
					<p>{m.match_complete_eyebrow()}</p>
					<h2>
						{client.finished.winnerSeat === mySeat
							? m.result_win()
							: client.finished.winnerSeat === null
								? m.result_draw_long()
								: m.result_loss()}
					</h2>
					<strong>{view.score[mySeat]} <span>—</span> {view.score[opponentSeat]}</strong>
					<a class="primary" href={resolve('/play')}>{m.action_find_opponent_again()}</a>
					<!-- 結果とリプレイは終局後にアーカイブされ、履歴から参照できる
					     （doc/designs/07-durable-objects.md 9.2）。 -->
					<a href={resolve('/history/[id]', { id: matchId })}>{m.match_result_replay_link()}</a>
				</section>
			</div>
		{/if}
	{/if}
</main>
