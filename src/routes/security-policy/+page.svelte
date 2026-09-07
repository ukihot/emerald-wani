<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import { CONTACT_EMAIL, SITE_DOMAIN } from '$lib/site';
	import '../legal.css';

	// doc/designs/20-vuln-disclosure.md 1.2 の項目をそのまま公開する。
</script>

<svelte:head><title>{m.security_policy_page_title()}</title></svelte:head>

<main class="legal-shell">
	<p class="eyebrow">{m.legal_eyebrow()}</p>
	<h1>セキュリティポリシー（脆弱性の報告）</h1>
	<p class="updated">制定日 2026-09-07 / 最終改定 2026-09-07</p>

	<div class="legal-body">
		<p>
			脆弱性を見つけた方は <code>{CONTACT_EMAIL}</code> までご報告ください。機械可読な窓口情報は
			<code>/.well-known/security.txt</code> にあります。
		</p>

		<h2>1. 対象範囲</h2>
		<ul>
			<li>対象: <code>{SITE_DOMAIN}</code> とその配下のアプリケーション・API・WebSocket</li>
			<li>
				<strong>対象外</strong>: 検証用（stg）環境、Cloudflare・Resend
				など第三者サービス自体の脆弱性、運営者が管理していないドメイン
			</li>
			<li>
				第三者サービスの脆弱性は、その提供元の窓口へご報告ください（本サービスの設定不備は対象です）。
			</li>
		</ul>

		<h2>2. 禁止事項</h2>
		<ul>
			<li>他の利用者のデータへの実際のアクセス・取得・改ざん・削除</li>
			<li>サービス妨害（負荷試験、大量リクエスト、対戦の意図的な妨害）</li>
			<li>ソーシャルエンジニアリング、物理的侵入、運営者・利用者への接触</li>
			<li>脆弱性を利用した対戦結果の操作</li>
		</ul>

		<h2>3. 安全な調査の指針</h2>
		<ul>
			<li>検証は<strong>自身のアカウント</strong>で行ってください。</li>
			<li>ゲストアカウントは自由に作成して構いません（発行回数の制限内で）。</li>
			<li>権限昇格や情報漏えいの確認は、<strong>可能性の確認まで</strong>にとどめてください。</li>
			<li>自動化ツールを使う場合は、通常の利用を妨げない速度に抑えてください。</li>
		</ul>

		<h2>4. 報告に含めてほしい情報</h2>
		<ul>
			<li>再現手順（可能ならリクエスト・レスポンス、対象URL、日時）</li>
			<li>想定される影響と、攻撃者が得られるもの</li>
			<li>検証に使ったアカウントの識別子（表示名など）</li>
			<li>謝辞への掲載可否と、掲載する場合の名義</li>
		</ul>

		<h2>5. 対応の約束</h2>
		<table>
			<thead>
				<tr><th>段階</th><th>目標期間</th></tr>
			</thead>
			<tbody>
				<tr><td>受領の確認</td><td>3営業日以内</td></tr>
				<tr><td>一次回答（再現可否と暫定的な重大度）</td><td>7日以内</td></tr>
				<tr><td>重大度判定の確定</td><td>14日以内</td></tr>
				<tr><td>修正（critical / high）</td><td>判定から30日以内</td></tr>
				<tr><td>修正（medium 以下）</td><td>次の計画的リリース</td></tr>
				<tr><td>公表の調整</td><td>修正完了後、原則90日以内</td></tr>
			</tbody>
		</table>
		<p>
			本ポリシーに従った誠実な報告に対して、運営者は<strong>法的措置を取りません。</strong>
			報告いただいた内容は、修正が完了するまで公表を控えていただくようお願いします。
		</p>

		<h2>6. 重大度の考え方</h2>
		<p>
			本サービスでは、<strong>確定前の相手の布陣が漏れること</strong>と<strong
				>対戦の公平性が直接損なわれること</strong
			>を最も重大な事象として扱います（認証の回避、他人のデータの閲覧・改ざんも同等です）。
		</p>

		<h2>7. 報奨</h2>
		<p>
			ベータ期間中、金銭による報奨はありません。ご希望があれば、修正の公表時に謝辞を掲載します（掲載しない選択もできます）。
		</p>
	</div>
</main>
