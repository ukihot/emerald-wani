<script lang="ts">
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import {
		CROCODILES,
		applyAction,
		cellId,
		completeDeployment,
		concede,
		createGame,
		definitionFor,
		deployCpu,
		endTurn,
		actionForCell as findActionForCell,
		getCellById,
		legalActionsForPiece,
		pieceAtCell,
		runCpuTurn,
		submitDeployment,
		suggestedDeployment,
		type Crocodile,
		type CrocodileKind,
		type DeploymentPlacement,
		type GameAction,
		type GameEvent,
		type GameState
	} from '$lib/game';
	import { m } from '$lib/paraglide/messages';
	import { terrainLabel } from '$lib/i18n/match-labels';
	import './game.css';

	const PLAYER = 0 as const;
	const CPU = 1 as const;
	const INITIAL_SEED = 'EMERALD-001';

	function createCpuMatch(seed: string): GameState {
		const deployed = deployCpu(createGame(seed), CPU);
		if (!deployed.ok) throw new Error(deployed.error);
		return deployed.value.state;
	}

	let seedInput = $state(INITIAL_SEED);
	let game = $state(createCpuMatch(INITIAL_SEED));
	let deployment = $state<Partial<Record<CrocodileKind, string>>>({});
	let selectedKind = $state<CrocodileKind | null>('nushi');
	let selectedPieceId = $state<string | null>(null);
	let eventLog = $state<string[]>([m.landing_log_initial()]);
	let secondsLeft = $state(45);
	let cpuThinking = $state(false);
	let errorMessage = $state('');
	let cpuRunId = 0;

	let selectedPiece = $derived(selectedPieceId ? game.pieces[selectedPieceId] : null);
	let legalActions = $derived(
		selectedPieceId ? legalActionsForPiece(game, selectedPieceId) : ([] as GameAction[])
	);
	let playerPiecesRemaining = $derived(
		Object.values(game.pieces).filter((piece) => piece.owner === PLAYER && !piece.removed).length
	);
	let cpuPiecesRemaining = $derived(
		Object.values(game.pieces).filter((piece) => piece.owner === CPU && !piece.removed).length
	);

	onMount(() => {
		const timer = window.setInterval(() => {
			if (game.phase === 'finished' || cpuThinking) return;
			secondsLeft -= 1;
			if (secondsLeft > 0) return;
			if (game.phase === 'deployment') {
				confirmDeployment(true);
			} else if (game.activeSeat === PLAYER) {
				finishPlayerTurn(true);
			}
		}, 1000);
		return () => window.clearInterval(timer);
	});

	function pushEvents(events: GameEvent[]) {
		eventLog = [...events.map((event) => event.message), ...eventLog].slice(0, 12);
	}

	function restart() {
		cpuRunId += 1;
		game = createCpuMatch(seedInput.trim() || INITIAL_SEED);
		deployment = {};
		selectedKind = 'nushi';
		selectedPieceId = null;
		secondsLeft = 45;
		cpuThinking = false;
		errorMessage = '';
		eventLog = [m.landing_log_restarted()];
	}

	function autoDeploy() {
		deployment = Object.fromEntries(
			suggestedDeployment(game, PLAYER).map((placement) => [placement.kind, placement.cellId])
		) as Record<CrocodileKind, string>;
		selectedKind = null;
	}

	function placeDeployment(cell: { id: string; zone: string; terrain: string }) {
		if (game.phase !== 'deployment' || !selectedKind) return;
		if (cell.zone !== 'south' || cell.terrain === 'nest' || cell.terrain === 'tree') {
			errorMessage = m.landing_deploy_zone_error();
			return;
		}
		const next = { ...deployment };
		for (const [kind, occupiedCell] of Object.entries(next)) {
			if (occupiedCell === cell.id) delete next[kind as CrocodileKind];
		}
		next[selectedKind] = cell.id;
		deployment = next;
		selectedKind = CROCODILES.find((definition) => !deployment[definition.kind])?.kind ?? null;
		errorMessage = '';
	}

	function toggleDeployment(kind: CrocodileKind) {
		if (deployment[kind]) {
			const next = { ...deployment };
			delete next[kind];
			deployment = next;
		}
		selectedKind = kind;
	}

	function confirmDeployment(autoComplete = false) {
		let placements = CROCODILES.flatMap<DeploymentPlacement>((definition) => {
			const target = deployment[definition.kind];
			return target ? [{ kind: definition.kind, cellId: target }] : [];
		});
		if (autoComplete) placements = completeDeployment(game, PLAYER, placements);
		const result = submitDeployment(game, PLAYER, placements);
		if (!result.ok) {
			errorMessage = result.error;
			return;
		}
		game = result.value.state;
		pushEvents(result.value.events);
		secondsLeft = 30;
		selectedKind = null;
		errorMessage = '';
	}

	function draftKindAt(targetCellId: string): CrocodileKind | undefined {
		return (Object.entries(deployment) as [CrocodileKind, string][]).find(
			([, occupied]) => occupied === targetCellId
		)?.[0];
	}

	function boardPiece(targetCellId: string): Crocodile | undefined {
		return game.phase === 'deployment' ? undefined : pieceAtCell(game, targetCellId);
	}

	function actionForCell(targetCellId: string): GameAction | undefined {
		const occupant = pieceAtCell(game, targetCellId);
		return findActionForCell(legalActions, targetCellId, occupant?.id);
	}

	function selectOrAct(targetCellId: string) {
		if (game.phase === 'deployment') {
			const cell = getCellById(game.board, targetCellId);
			if (cell) placeDeployment(cell);
			return;
		}
		if (game.phase !== 'playing' || game.activeSeat !== PLAYER || cpuThinking) return;
		const targetAction = actionForCell(targetCellId);
		if (targetAction) return executeAction(targetAction);
		const occupant = pieceAtCell(game, targetCellId);
		selectedPieceId = occupant?.owner === PLAYER ? occupant.id : null;
		errorMessage = '';
	}

	function executeAction(requested: GameAction) {
		const result = applyAction(game, requested);
		if (!result.ok) {
			errorMessage = result.error;
			return;
		}
		game = result.value.state;
		pushEvents(result.value.events);
		selectedPieceId = null;
		errorMessage = '';
	}

	function finishPlayerTurn(timedOut = false) {
		const result = endTurn(game, timedOut);
		if (!result.ok) {
			errorMessage = result.error;
			return;
		}
		game = result.value.state;
		pushEvents(result.value.events);
		selectedPieceId = null;
		if (game.phase === 'playing') scheduleCpu();
	}

	function scheduleCpu() {
		const scheduledRunId = ++cpuRunId;
		cpuThinking = true;
		secondsLeft = 30;
		window.setTimeout(() => {
			if (scheduledRunId !== cpuRunId || game.phase !== 'playing') return;
			const result = runCpuTurn(game, CPU);
			if (!result.ok) {
				errorMessage = result.error;
				cpuThinking = false;
				return;
			}
			game = result.value.state;
			pushEvents(result.value.events);
			cpuThinking = false;
			secondsLeft = 30;
		}, 520);
	}

	function resign() {
		const result = concede(game, PLAYER);
		if (!result.ok) return;
		cpuRunId += 1;
		cpuThinking = false;
		game = result.value.state;
		pushEvents(result.value.events);
	}

	function cellLabel(targetCellId: string): string {
		const cell = getCellById(game.board, targetCellId);
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
		if (candidate.type === 'feed') return m.action_destination_here();
		const target = candidate.targetPieceId ? game.pieces[candidate.targetPieceId] : null;
		const destination = candidate.toCellId ?? (target?.position ? cellId(target.position) : '');
		return destination ? m.action_destination_to({ cell: destination }) : '';
	}
</script>

<svelte:head>
	<title>{m.landing_page_title()}</title>
	<meta name="description" content={m.app_description()} />
</svelte:head>

<main class="game-shell">
	<header class="topbar">
		<div>
			<p class="eyebrow">{m.landing_eyebrow()}</p>
			<h1>{m.app_name_head()}<span>{m.app_name_tail()}</span></h1>
			<p class="tagline">{m.app_tagline()}</p>
		</div>
		<nav class="landing-nav" aria-label={m.nav_menu_label()}>
			<a href={resolve('/home')}>{m.nav_home()}</a>
			<a href={resolve('/play')}>{m.nav_online_match()}</a>
			<a href={resolve('/history')}>{m.nav_history()}</a>
		</nav>
		<div class="seed-control">
			<label for="map-seed">{m.landing_map_seed_label()}</label>
			<div>
				<input id="map-seed" bind:value={seedInput} maxlength="32" /><button
					type="button"
					onclick={restart}>{m.landing_regenerate()}</button
				>
			</div>
			<small>{game.mapVersion}</small>
		</div>
	</header>

	<section class="score-strip" aria-label={m.score_strip_label()}>
		<div class="side-score enemy">
			<span>{m.seat_cpu()}</span><strong>{game.score[CPU]}<small>{m.score_suffix()}</small></strong
			><em>{m.score_pieces_remaining({ count: cpuPiecesRemaining })}</em>
		</div>
		<div class="turn-status">
			<i class:live={game.phase === 'playing'}></i>
			<strong
				>{game.phase === 'deployment'
					? m.phase_deployment()
					: game.phase === 'finished'
						? m.phase_finished()
						: cpuThinking
							? m.phase_cpu_thinking()
							: m.phase_your_turn()}</strong
			>
			<small>{m.round_and_turn({ round: game.round, turn: game.turnNumber })}</small>
		</div>
		<div class="side-score player">
			<span>{m.board_label_you()}</span><strong
				>{game.score[PLAYER]}<small>{m.score_suffix()}</small></strong
			><em>{m.score_pieces_remaining({ count: playerPiecesRemaining })}</em>
		</div>
	</section>

	<div class="play-layout">
		<aside class="panel briefing">
			<div class="panel-heading">
				<span>01</span>
				<div>
					<p>{m.panel_mission_eyebrow()}</p>
					<h2>{m.panel_mission_heading()}</h2>
				</div>
			</div>
			<div class="mission-card">
				<strong>{m.panel_mission_goal()}</strong>
				<p>{m.panel_mission_detail()}</p>
			</div>
			<ul class="terrain-key">
				<li><span class="key"></span>{m.terrain_normal()}</li>
				<li><span class="key swamp">≋</span>{m.terrain_swamp()}</li>
				<li><span class="key">♠</span>{m.terrain_tree()}</li>
				<li><span class="key nest">⌂</span>{m.terrain_nest()}</li>
				<li><span class="key void"></span>{m.terrain_void()}</li>
			</ul>
			<div class="rule-note">
				<span>{m.panel_rule_vitality_label()}</span>
				<p>{m.panel_rule_vitality_detail()}</p>
			</div>
			<div class="rule-note">
				<span>{m.panel_rule_transport_label()}</span>
				<p>{m.panel_rule_transport_detail()}</p>
			</div>
		</aside>

		<section class="board-column" aria-label={m.board_region_label()}>
			<div class="board-meta">
				<span>{m.board_meta_enemy_nest()}</span><i></i><span>{m.board_meta_north_zone()}</span>
			</div>
			<div class="board" style={`--columns: ${game.board.width}`}>
				{#each game.board.cells as cell (cell.id)}
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
						class:home={cell.zone === 'south'}
						class:legal={Boolean(targetAction)}
						class:selected={piece?.id === selectedPieceId}
						disabled={cell.terrain === 'void'}
						class:deployable={game.phase === 'deployment' &&
							cell.zone === 'south' &&
							cell.terrain !== 'nest'}
						onclick={() => selectOrAct(cell.id)}
						aria-label={cellLabel(cell.id)}
					>
						<span class="coordinates">{cell.x + 1}.{cell.y + 1}</span>
						{#if cell.terrain === 'tree'}<span class="terrain-icon tree-icon">♠</span>
						{:else if cell.terrain === 'swamp'}<span class="terrain-icon">≋</span>
						{:else if cell.terrain === 'nest'}<span class="terrain-icon">⌂</span>{/if}
						{#if piece}
							<span class:ours={piece.owner === PLAYER} class="croc">
								<b>{definitionFor(piece.kind).shortName}</b><small
									>{piece.owner === PLAYER ? m.board_label_you() : m.board_label_cpu()}</small
								>
								{#if piece.captiveId}<span
										class="captive"
										title={m.board_captive_title({
											name: definitionFor(game.pieces[piece.captiveId].kind).name
										})}>{definitionFor(game.pieces[piece.captiveId].kind).shortName}</span
									>{/if}
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
			<div class="board-meta bottom">
				<span>{m.board_meta_your_nest()}</span><i></i><span>{m.board_meta_south_zone()}</span>
			</div>

			<div class="vitality-bar">
				<div>
					<span>{m.panel_vitality()}</span>
					<div class="pips">
						<i class:filled={game.vitality[PLAYER] >= 1}></i><i
							class:filled={game.vitality[PLAYER] >= 2}
						></i>
					</div>
				</div>
				<div class:urgent={secondsLeft <= 10} class="clock">
					<span>{m.panel_time()}</span><strong>00:{String(secondsLeft).padStart(2, '0')}</strong>
				</div>
			</div>
			{#if errorMessage}<p class="error" role="alert">{errorMessage}</p>{/if}
			<div class="main-actions">
				{#if game.phase === 'deployment'}
					<button type="button" class="secondary" onclick={autoDeploy}
						>{m.action_auto_deploy()}</button
					>
					<button
						type="button"
						class="primary"
						disabled={Object.keys(deployment).length !== 8}
						onclick={() => confirmDeployment(false)}
						>{m.action_confirm_deployment({ placed: Object.keys(deployment).length })}</button
					>
				{:else if game.phase === 'playing'}
					<button type="button" class="secondary danger" onclick={resign}
						>{m.action_resign()}</button
					>
					<button
						type="button"
						class="primary"
						disabled={game.activeSeat !== PLAYER || cpuThinking}
						onclick={() => finishPlayerTurn(false)}>{m.action_end_turn()}</button
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
						{game.phase === 'deployment' ? m.panel_command_deployment() : m.panel_command_playing()}
					</h2>
				</div>
			</div>
			{#if game.phase === 'deployment'}
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
			{:else if selectedPiece}
				<div class="selected-card">
					<span>{definitionFor(selectedPiece.kind).shortName}</span>
					<div>
						<p>{m.panel_selected_eyebrow()}</p>
						<h3>{definitionFor(selectedPiece.kind).name}</h3>
						<small>{definitionFor(selectedPiece.kind).description}</small>
					</div>
				</div>
				<div class="legal-list">
					{#each legalActions as candidate, index (`${candidate.type}:${candidate.toCellId}:${candidate.targetPieceId}:${index}`)}
						<button type="button" onclick={() => executeAction(candidate)}
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
					<p>{m.select_prompt_detail()}</p>
				</div>
			{/if}

			<div class="event-log">
				<p>{m.panel_field_log()}</p>
				<ol>
					{#each eventLog as message, index (`${index}:${message}`)}<li class:latest={index === 0}>
							{message}
						</li>{/each}
				</ol>
			</div>
		</aside>
	</div>

	{#if game.phase === 'finished'}
		<div class="result-backdrop">
			<section class="result-card" aria-live="assertive">
				<p>{m.match_complete_eyebrow()}</p>
				<h2>
					{game.winner === PLAYER
						? m.result_win()
						: game.winner === 'draw'
							? m.result_draw_long()
							: m.result_loss()}
				</h2>
				<strong>{game.score[PLAYER]} <span>—</span> {game.score[CPU]}</strong><small
					>{eventLog[0]}</small
				>
				<button type="button" class="primary" onclick={restart}>{m.action_rematch()}</button>
			</section>
		</div>
	{/if}
</main>
