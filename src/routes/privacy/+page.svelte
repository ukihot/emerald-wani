<script lang="ts">
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages';
	import { CONTACT_EMAIL } from '$lib/site';
	import '../legal.css';
</script>

<svelte:head><title>{m.privacy_page_title()}</title></svelte:head>

<main class="legal-shell">
	<p class="eyebrow">{m.legal_eyebrow()}</p>
	<h1>プライバシーポリシー</h1>
	<p class="updated">制定日 2026-09-07 / 最終改定 2026-09-07</p>

	<div class="legal-body">
		<h2>1. 取得する情報</h2>
		<table>
			<thead>
				<tr><th>情報</th><th>取得の場面</th><th>目的</th></tr>
			</thead>
			<tbody>
				<tr>
					<td>メールアドレス</td>
					<td>本登録、パスワード再設定</td>
					<td>本人確認、パスワード再設定、重要なお知らせ</td>
				</tr>
				<tr>
					<td>表示名</td>
					<td>ゲスト発行・本登録</td>
					<td>対戦相手・履歴での識別</td>
				</tr>
				<tr>
					<td>パスワード</td>
					<td>本登録</td>
					<td>認証。<strong>ハッシュ化して保存し、平文では保持しません。</strong></td>
				</tr>
				<tr>
					<td>Cookie（セッション）</td>
					<td>ログイン・ゲスト開始</td>
					<td>ログイン状態の維持。広告・行動追跡には利用しません。</td>
				</tr>
				<tr>
					<td>対戦記録（操作ログ・リプレイ）</td>
					<td>対戦中</td>
					<td>対戦の進行と再現、戦績表示、不正調査</td>
				</tr>
				<tr>
					<td>通報の内容</td>
					<td>通報フォーム</td>
					<td>違反の確認と対応</td>
				</tr>
				<tr>
					<td>IPアドレス・ブラウザ情報</td>
					<td>アクセス時</td>
					<td>
						不正利用の抑止。<strong
							>監査記録には日次で変わるソルト付きのハッシュのみを保存し、生の値は保存しません。</strong
						>
					</td>
				</tr>
			</tbody>
		</table>

		<h2>2. 利用目的</h2>
		<ul>
			<li>本サービスの提供（対戦の進行、戦績・リプレイの表示）</li>
			<li>不正利用・妨害行為の検知と対応、通報への対応</li>
			<li>障害の調査と復旧、品質の改善</li>
			<li>重要なお知らせの通知</li>
		</ul>
		<p>取得した情報を広告配信・プロファイリング・第三者への販売に利用することはありません。</p>

		<h2>3. 保存期間</h2>
		<table>
			<thead>
				<tr><th>対象</th><th>期間</th></tr>
			</thead>
			<tbody>
				<tr><td>リプレイ</td><td>90日</td></tr>
				<tr><td>対戦結果・戦績</td><td>無期限（アカウント削除時は匿名化して保持）</td></tr>
				<tr><td>セキュリティ監査ログ</td><td>400日</td></tr>
				<tr><td>運営操作の履歴</td><td>3年</td></tr>
				<tr><td>デバッグログ</td><td>7日</td></tr>
				<tr><td>アカウント（削除申請後）</td><td>30日後に個人情報を消去</td></tr>
			</tbody>
		</table>

		<h2>4. 第三者への提供・委託</h2>
		<p>次の事業者に処理を委託します。いずれも本サービスの運営に必要な範囲に限られます。</p>
		<table>
			<thead>
				<tr><th>委託先</th><th>用途</th><th>渡る情報</th></tr>
			</thead>
			<tbody>
				<tr>
					<td>Cloudflare, Inc.</td>
					<td>アプリケーションの実行、データベース、リプレイの保管、Bot対策（Turnstile）</td>
					<td>本ポリシーに記載の情報全般、接続情報</td>
				</tr>
				<tr>
					<td>Resend, Inc.</td>
					<td>確認メール・パスワード再設定メールの配送</td>
					<td>メールアドレス、メール本文</td>
				</tr>
			</tbody>
		</table>
		<p>
			上記のほか、法令に基づく開示要請があった場合を除き、第三者へ個人情報を提供することはありません。
		</p>

		<h2>5. 保護のための措置</h2>
		<ul>
			<li>通信はすべて TLS で暗号化します。</li>
			<li>パスワードはハッシュ化して保存します。</li>
			<li>運営用画面へのアクセスは多要素認証を必須とし、操作を記録します。</li>
			<li>IPアドレス等の識別子は監査記録へ生の値を保存しません（1節）。</li>
		</ul>

		<h2>6. 利用者の権利</h2>
		<p>
			登録内容の確認・訂正、アカウントの削除、対戦履歴のエクスポート、および取得情報の開示を請求できます。<a
				href={resolve('/contact')}>お問い合わせ窓口</a
			>からご連絡ください。ご本人であることを確認したうえで、原則2週間以内に対応します。
		</p>
		<p>
			なお、不正調査・法令対応のために必要な監査記録は、削除の請求があっても保存期間の満了まで保持することがあります。
		</p>

		<h2>7. 未成年の利用</h2>
		<p>
			未成年の方は、保護者の同意を得たうえで利用してください。年齢に関する情報は取得していません。
		</p>

		<h2>8. 改定</h2>
		<p>本ポリシーは改定することがあります。重要な変更は本ページで告知します。</p>

		<h2>9. 連絡先</h2>
		<p>
			個人情報の取り扱いに関するお問い合わせ: <code>{CONTACT_EMAIL}</code>（<a
				href={resolve('/contact')}>窓口の一覧</a
			>）
		</p>
	</div>
</main>
