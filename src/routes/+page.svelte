<script lang="ts">
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
	let eventLog = $state<string[]>(['地形を公開しました。8体を配置してください。']);
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
		eventLog = ['新しい地形を公開しました。布陣を開始してください。'];
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
			errorMessage = '手前の味方ゾーンにある、巣以外のマスを選んでください。';
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
		return legalActions.find(
			(candidate) => candidate.toCellId === targetCellId || candidate.targetPieceId === occupant?.id
		);
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
		const terrain = { normal: '通常', swamp: '沼', tree: '木', nest: '巣', void: '盤外' }[
			cell.terrain
		];
		const name = occupant
			? definitionFor(occupant.kind).name
			: draft
				? definitionFor(draft).name
				: '空き';
		return `${cell.x + 1}列${cell.y + 1}段、${terrain}、${name}`;
	}

	function actionDestination(candidate: GameAction): string {
		if (candidate.type === 'feed') return 'この場で実行';
		const target = candidate.targetPieceId ? game.pieces[candidate.targetPieceId] : null;
		const destination = candidate.toCellId ?? (target?.position ? cellId(target.position) : '');
		return destination ? `→ ${destination}` : '';
	}
</script>

<svelte:head>
	<title>エメラルドワニ | バーティカルスライス</title>
	<meta name="description" content="敵のワニを捕獲し、巣へ運び、3ポイントを目指す盤面ゲーム" />
</svelte:head>

<main class="game-shell">
	<header class="topbar">
		<div>
			<p class="eyebrow">TACTICAL MARSH / PROTOTYPE</p>
			<h1>エメラルド<span>ワニ</span></h1>
			<p class="tagline">噛んで、担いで、巣へ帰れ。</p>
		</div>
		<div class="seed-control">
			<label for="map-seed">MAP SEED</label>
			<div>
				<input id="map-seed" bind:value={seedInput} maxlength="32" /><button
					type="button"
					onclick={restart}>再生成</button
				>
			</div>
			<small>{game.mapVersion}</small>
		</div>
	</header>

	<section class="score-strip" aria-label="対戦状況">
		<div class="side-score enemy">
			<span>CPU</span><strong>{game.score[CPU]}<small>/3P</small></strong><em
				>残り {cpuPiecesRemaining}体</em
			>
		</div>
		<div class="turn-status">
			<i class:live={game.phase === 'playing'}></i>
			<strong
				>{game.phase === 'deployment'
					? '布陣フェーズ'
					: game.phase === 'finished'
						? '対局終了'
						: cpuThinking
							? 'CPU 思考中'
							: 'あなたのターン'}</strong
			>
			<small>ROUND {game.round} · TURN {game.turnNumber}</small>
		</div>
		<div class="side-score player">
			<span>YOU</span><strong>{game.score[PLAYER]}<small>/3P</small></strong><em
				>残り {playerPiecesRemaining}体</em
			>
		</div>
	</section>

	<div class="play-layout">
		<aside class="panel briefing">
			<div class="panel-heading">
				<span>01</span>
				<div>
					<p>MISSION</p>
					<h2>作戦概要</h2>
				</div>
			</div>
			<div class="mission-card">
				<strong>先に 3P</strong>
				<p>敵の特殊ワニを捕獲し、手前の巣まで運んで捕食。</p>
			</div>
			<ul class="terrain-key">
				<li><span class="key"></span>通常</li>
				<li><span class="key swamp">≋</span>沼</li>
				<li><span class="key">♠</span>木</li>
				<li><span class="key nest">⌂</span>巣</li>
				<li><span class="key void"></span>盤外</li>
			</ul>
			<div class="rule-note">
				<span>活力</span>
				<p>通常2。先手の最初のターンだけ1。</p>
			</div>
			<div class="rule-note">
				<span>運搬</span>
				<p>通常2活力、カツギワニは1活力。</p>
			</div>
		</aside>

		<section class="board-column" aria-label="ゲーム盤">
			<div class="board-meta"><span>ENEMY NEST</span><i></i><span>NORTH ZONE</span></div>
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
									>{piece.owner === PLAYER ? 'YOU' : 'CPU'}</small
								>
								{#if piece.captiveId}<span
										class="captive"
										title={`捕虜：${definitionFor(game.pieces[piece.captiveId].kind).name}`}
										>{definitionFor(game.pieces[piece.captiveId].kind).shortName}</span
									>{/if}
							</span>
						{:else if draftKind}
							<span class="croc ours draft"
								><b>{definitionFor(draftKind).shortName}</b><small>配置</small></span
							>
						{/if}
						{#if targetAction}<span class="action-hint">{targetAction.cost}</span>{/if}
					</button>
				{/each}
			</div>
			<div class="board-meta bottom"><span>YOUR NEST</span><i></i><span>SOUTH ZONE</span></div>

			<div class="vitality-bar">
				<div>
					<span>VITALITY</span>
					<div class="pips">
						<i class:filled={game.vitality[PLAYER] >= 1}></i><i
							class:filled={game.vitality[PLAYER] >= 2}
						></i>
					</div>
				</div>
				<div class:urgent={secondsLeft <= 10} class="clock">
					<span>TIME</span><strong>00:{String(secondsLeft).padStart(2, '0')}</strong>
				</div>
			</div>
			{#if errorMessage}<p class="error" role="alert">{errorMessage}</p>{/if}
			<div class="main-actions">
				{#if game.phase === 'deployment'}
					<button type="button" class="secondary" onclick={autoDeploy}>おすすめ配置</button>
					<button
						type="button"
						class="primary"
						disabled={Object.keys(deployment).length !== 8}
						onclick={() => confirmDeployment(false)}
						>布陣を確定 ({Object.keys(deployment).length}/8)</button
					>
				{:else if game.phase === 'playing'}
					<button type="button" class="secondary danger" onclick={resign}>投了</button>
					<button
						type="button"
						class="primary"
						disabled={game.activeSeat !== PLAYER || cpuThinking}
						onclick={() => finishPlayerTurn(false)}>ターン終了</button
					>
				{/if}
			</div>
		</section>

		<aside class="panel command-panel">
			<div class="panel-heading">
				<span>02</span>
				<div>
					<p>COMMAND</p>
					<h2>{game.phase === 'deployment' ? 'ワニを選択' : '行動選択'}</h2>
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
						<p>SELECTED</p>
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
					{:else}<p class="empty-state">残り活力で実行できる行動はありません。</p>{/each}
				</div>
			{:else}
				<div class="select-prompt">
					<span>⌖</span><strong>自分のワニを選択</strong>
					<p>移動先と噛みつける敵が発光します。</p>
				</div>
			{/if}

			<div class="event-log">
				<p>FIELD LOG</p>
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
				<p>MATCH COMPLETE</p>
				<h2>{game.winner === PLAYER ? '勝利' : game.winner === 'draw' ? '引き分け' : '敗北'}</h2>
				<strong>{game.score[PLAYER]} <span>—</span> {game.score[CPU]}</strong><small
					>{eventLog[0]}</small
				>
				<button type="button" class="primary" onclick={restart}>同じ条件でもう一戦</button>
			</section>
		</div>
	{/if}
</main>
