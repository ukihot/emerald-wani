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
		if (!view) return '';
		if (candidate.type === 'feed') return 'この場で実行';
		const target = candidate.targetPieceId ? view.pieces[candidate.targetPieceId] : null;
		const destination = candidate.toCellId ?? (target?.position ? cellId(target.position) : '');
		return destination ? `→ ${destination}` : '';
	}

	function clockLabel(): string {
		if (!Number.isFinite(remainingMs)) return '--:--';
		const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
		return `00:${String(seconds).padStart(2, '0')}`;
	}
</script>

<svelte:head>
	<title>オンライン対戦 | エメラルドワニ</title>
</svelte:head>

<main class="game-shell">
	<header class="topbar">
		<div>
			<p class="eyebrow">ONLINE MATCH</p>
			<h1>エメラルド<span>ワニ</span></h1>
			<p class="tagline">
				{client.status === 'open'
					? '接続中'
					: client.status === 'reconnecting'
						? '再接続しています…'
						: client.status === 'connecting'
							? '接続しています…'
							: '切断されました'}
				{#if !client.opponentConnected}（相手が切断中）{/if}
			</p>
		</div>
	</header>

	{#if !view}
		<p class="mission-card">対戦データを読み込んでいます…</p>
	{:else}
		<section class="score-strip" aria-label="対戦状況">
			<div class="side-score enemy">
				<span>相手</span><strong>{view.score[opponentSeat]}<small>/3P</small></strong>
			</div>
			<div class="turn-status">
				<i class:live={view.phase === 'playing'}></i>
				<strong>
					{view.phase === 'deployment'
						? '布陣フェーズ'
						: view.phase === 'finished'
							? '対局終了'
							: view.activeSeat === mySeat
								? 'あなたのターン'
								: '相手のターン'}
				</strong>
				<small>ROUND {view.round}</small>
			</div>
			<div class="side-score player">
				<span>あなた</span><strong>{view.score[mySeat]}<small>/3P</small></strong>
			</div>
		</section>

		<div class="play-layout">
			<section class="board-column" aria-label="ゲーム盤">
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
									<small>{piece.owner === mySeat ? 'YOU' : 'ENEMY'}</small>
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

				<div class="vitality-bar">
					<div>
						<span>VITALITY</span>
						<div class="pips">
							<i class:filled={view.vitality[mySeat] >= 1}></i><i
								class:filled={view.vitality[mySeat] >= 2}
							></i>
						</div>
					</div>
					<div class:urgent={remainingMs <= 10_000} class="clock">
						<span>TIME</span><strong>{clockLabel()}</strong>
					</div>
				</div>

				{#if client.lastError}<p class="error" role="alert">{client.lastError.message}</p>{/if}

				<div class="main-actions">
					{#if view.phase === 'deployment'}
						<button
							type="button"
							class="primary"
							disabled={Object.keys(deployment).length !== 8 || submitting}
							onclick={confirmDeployment}>布陣を確定 ({Object.keys(deployment).length}/8)</button
						>
					{:else if view.phase === 'playing'}
						<button type="button" class="secondary danger" onclick={resign}>投了</button>
						<button
							type="button"
							class="primary"
							disabled={view.activeSeat !== mySeat || submitting}
							onclick={finishTurn}>ターン終了</button
						>
					{/if}
				</div>
			</section>

			<aside class="panel command-panel">
				<div class="panel-heading">
					<span>02</span>
					<div>
						<p>COMMAND</p>
						<h2>{view.phase === 'deployment' ? 'ワニを選択' : '行動選択'}</h2>
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
						{:else}<p class="empty-state">残り活力で実行できる行動はありません。</p>{/each}
					</div>
				{:else}
					<div class="select-prompt">
						<span>⌖</span><strong>自分のワニを選択</strong>
					</div>
				{/if}

				<div class="event-log">
					<p>FIELD LOG</p>
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
					<p>MATCH COMPLETE</p>
					<h2>
						{client.finished.winnerSeat === mySeat
							? '勝利'
							: client.finished.winnerSeat === null
								? '引き分け'
								: '敗北'}
					</h2>
					<strong>{view.score[mySeat]} <span>—</span> {view.score[opponentSeat]}</strong>
					<a class="primary" href={resolve('/play')}>もう一度対戦相手を探す</a>
				</section>
			</div>
		{/if}
	{/if}
</main>
