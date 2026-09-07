<script lang="ts">
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages';
	import { CONTACT_EMAIL } from '$lib/site';
	import '../legal.css';

	// 窓口はメール1つに集約し、件名で仕分ける（問い合わせフォームは Bot 対策と
	// 保管先の設計が別に要るため、ベータ期間は用意しない。
	// doc/designs/21-roadmap.md フェーズ7の意図的な変更）。
</script>

<svelte:head><title>{m.contact_page_title()}</title></svelte:head>

<main class="legal-shell">
	<p class="eyebrow">{m.legal_eyebrow()}</p>
	<h1>お問い合わせ</h1>
	<p class="updated">最終更新 2026-09-07</p>

	<div class="legal-body">
		<p>
			お問い合わせはすべて <code>{CONTACT_EMAIL}</code> で受け付けます。<strong
				>件名の先頭に用件の区分を付けてください。</strong
			>返信は日本語または英語で行います。
		</p>

		<table>
			<thead>
				<tr><th>用件</th><th>件名の先頭</th><th>対応の目標</th></tr>
			</thead>
			<tbody>
				<tr>
					<td>一般のお問い合わせ・不具合の報告</td>
					<td><code>[support]</code></td>
					<td>5営業日以内に返信</td>
				</tr>
				<tr>
					<td>アカウント停止・制限への異議申立て</td>
					<td><code>[appeal]</code></td>
					<td>受領確認3営業日以内 / 結論14日以内</td>
				</tr>
				<tr>
					<td>個人情報の開示・訂正・削除</td>
					<td><code>[privacy]</code></td>
					<td>2週間以内</td>
				</tr>
				<tr>
					<td>脆弱性の報告</td>
					<td><code>[security]</code></td>
					<td>
						<a href={resolve('/security-policy')}>セキュリティポリシー</a>の目標期間
					</td>
				</tr>
			</tbody>
		</table>

		<h2>異議申立てについて</h2>
		<p>
			アカウントの停止・制限を受けた方は、件名を <code>[appeal]</code>
			で始めてご連絡ください。再審査は<strong>当初の判断を行った者以外</strong
			>が根拠を確認して行います。誤った判定と判明した場合は、速やかに解除し、失われた戦績を復旧します。
		</p>
		<p>
			申立ての際は、表示名または登録メールアドレスと、心当たりのある対戦の日時をお知らせください。
		</p>

		<h2>対戦相手の通報</h2>
		<p>
			対戦中・対戦後の違反行為は、対戦結果画面の通報フォームからお送りください。メールより早く処理できます。
		</p>

		<h2>ご連絡いただく前に</h2>
		<ul>
			<li>
				データの取り扱いは<a href={resolve('/privacy')}>プライバシーポリシー</a>に、利用条件は<a
					href={resolve('/terms')}>利用規約</a
				>に記載しています。
			</li>
			<li>
				本サービスは<strong>ベータ公開中</strong
				>です。既知の制限については返信が定型になる場合があります。
			</li>
		</ul>
	</div>
</main>
