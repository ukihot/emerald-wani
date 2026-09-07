<script lang="ts">
	import { enhance } from '$app/forms';
	import { m } from '$lib/paraglide/messages';
	import { formatDateTime } from '$lib/i18n/match-labels';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<section class="card">
	<h2>{m.admin_security_events()}</h2>
	{#if data.events.length === 0}
		<p class="lead">{m.admin_empty()}</p>
	{:else}
		<table>
			<thead>
				<tr>
					<th scope="col">{m.admin_column_time()}</th>
					<th scope="col">{m.admin_column_type()}</th>
					<th scope="col">{m.admin_column_severity()}</th>
					<th scope="col">{m.admin_column_user()}</th>
					<th scope="col">{m.admin_column_detail()}</th>
				</tr>
			</thead>
			<tbody>
				{#each data.events as row (row.id)}
					<tr>
						<td>{formatDateTime(row.ts)}</td>
						<td>{row.type}</td>
						<td>{row.severity}</td>
						<td>{row.userId ?? '—'}</td>
						<td><code>{row.detail}</code></td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</section>

<section class="card">
	<h2>{m.admin_reports()}</h2>
	{#if data.reports.length === 0}
		<p class="lead">{m.admin_empty()}</p>
	{:else}
		<table>
			<thead>
				<tr>
					<th scope="col">{m.admin_column_time()}</th>
					<th scope="col">{m.admin_column_user()}</th>
					<th scope="col">{m.admin_column_reason()}</th>
					<th scope="col">{m.admin_column_status()}</th>
					<th scope="col"><span class="visually-hidden">{m.admin_column_detail()}</span></th>
				</tr>
			</thead>
			<tbody>
				{#each data.reports as row (row.id)}
					<tr>
						<td>{formatDateTime(row.createdAt)}</td>
						<td>{row.targetUserId}</td>
						<td>{row.reason}</td>
						<td>{row.status}</td>
						<td>
							<form method="post" action="?/updateReport" use:enhance class="form-actions">
								<input type="hidden" name="reportId" value={row.id} />
								<button type="submit" name="status" value="reviewing">
									{m.admin_report_review()}
								</button>
								<button type="submit" name="status" value="actioned">
									{m.admin_report_actioned()}
								</button>
								<button type="submit" name="status" value="dismissed">
									{m.admin_report_dismiss()}
								</button>
							</form>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</section>
