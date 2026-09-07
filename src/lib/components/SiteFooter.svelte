<script lang="ts">
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages';
</script>

<!--
	公開時の必須導線（doc/designs/21-roadmap.md フェーズ7）。
	規約・ポリシー・窓口はどの画面からも1クリックで届く必要がある。
	対局中の画面（/play, /online, /admin, ルートのCPU戦）では邪魔になるため
	+layout.svelte 側で出し分ける。
-->
<footer class="site-footer">
	<p class="site-footer-beta">{m.footer_beta_notice()}</p>
	<nav aria-label={m.footer_nav_label()}>
		<a href={resolve('/terms')}>{m.footer_terms()}</a>
		<a href={resolve('/privacy')}>{m.footer_privacy()}</a>
		<a href={resolve('/security-policy')}>{m.footer_security_policy()}</a>
		<a href={resolve('/contact')}>{m.footer_contact()}</a>
	</nav>
</footer>

<style>
	.site-footer {
		width: min(880px, 100%);
		margin: 0 auto;
		padding: 24px clamp(16px, 4vw, 40px) 40px;
		border-top: 1px solid #1b2a22;
		color: #7f9188;
		font-size: 0.74rem;
	}

	.site-footer-beta {
		margin: 0 0 10px;
	}

	nav {
		display: flex;
		flex-wrap: wrap;
		gap: 14px;
	}

	a {
		color: #a9bcb2;
	}

	a:hover {
		color: #42e59b;
	}
</style>
