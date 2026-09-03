# 参考資料

> [設計ドキュメント索引](./README.md)

## Cloudflare / フレームワーク

- [Wrangler API — getPlatformProxy の Durable Object 制約](https://developers.cloudflare.com/workers/wrangler/api/)
- [Durable Objects — WebSocket Hibernation API](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Durable Object class exports（`exports` フィールド）](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
- [Workers Rate Limiting バインディング](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Workers ローカル開発（Miniflare / workerd）](https://developers.cloudflare.com/workers/local-development/)
- [D1 ローカル開発](https://developers.cloudflare.com/d1/best-practices/local-development/)
- [Turnstile サーバサイド検証](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- [Turnstile Content-Security-Policy](https://developers.cloudflare.com/turnstile/reference/content-security-policy/)
- [SvelteKit adapter-cloudflare](https://svelte.dev/docs/kit/adapter-cloudflare)
- [SvelteKit CSP設定（Svelteトランジションとstyle-src）](https://svelte.dev/docs/kit/configuration#csp)
- [Durable Object Lifecycle（コード更新時の再起動・WebSocket切断）](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
- [Cloudflare Queues の上限（メッセージサイズ・保持期間）](https://developers.cloudflare.com/queues/platform/limits/)
- [Cloudflare Queues が Workers Free プランで利用可能に（24時間保持）](https://developers.cloudflare.com/changelog/post/2026-02-04-queues-free-plan/)
- [D1 Time Travel（保持日数）](https://developers.cloudflare.com/d1/reference/time-travel/)
- [D1 Free プランの日次クエリ上限の施行](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/)
- [Workers Rate Limiting バインディングの `period` 制約](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [better-auth Anonymous プラグイン](https://better-auth.com/docs/plugins/anonymous)
- [better-auth Email 概念（メール配送はアプリ側で用意）](https://better-auth.com/docs/concepts/email)
- [rand_xoshiro（xoshiro128\*\* は非暗号用途）](https://docs.rs/rand_xoshiro/latest/rand_xoshiro/struct.Xoshiro128StarStar.html)
- [Svelte — transition ディレクティブ](https://svelte.dev/docs/svelte/transition)
- [Svelte — animate ディレクティブ / `flip`](https://svelte.dev/docs/svelte/animate)
- [Svelte — `svelte/motion`（`Tween` / `Spring` / `prefersReducedMotion`）](https://svelte.dev/docs/svelte/svelte-motion)
- [Svelte — カスタムトランジション](https://svelte.dev/docs/svelte/custom-transitions)
- [SvelteKit — `onNavigate` と View Transitions](https://svelte.dev/docs/kit/$app-navigation#onNavigate)
- [Tailwind CSS 4 — `@theme` によるトークン定義](https://tailwindcss.com/docs/theme)

## セキュリティ基準・運用

- [OWASP ASVS（Application Security Verification Standard）](https://owasp.org/www-project-application-security-verification-standard/)
- [RFC 9116 — `security.txt`](https://www.rfc-editor.org/rfc/rfc9116)
- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Cloudflare Access（Zero Trust）](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/)
- [R2 の料金と無料枠](https://developers.cloudflare.com/r2/pricing/)
