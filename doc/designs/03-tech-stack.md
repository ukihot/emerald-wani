# 技術スタックとプラン制約

> [設計ドキュメント索引](./README.md)

### 4.1 既存スキャフォールドから継続

| 領域 | 採用 | 備考 |
|---|---|---|
| フレームワーク | SvelteKit 2 / Svelte 5（runes 強制） | `vite.config.ts` で `runes: true` 設定済み |
| 言語 | TypeScript 6 | `strict` |
| CSS | Tailwind CSS 4 + Scoped CSS | 役割分担は 14.3 |
| 認証 | better-auth 1.7 | プラグイン構成は 10章 |
| ORM | Drizzle ORM 0.45 / drizzle-kit | D1 |
| i18n | Paraglide JS 2（ja / en） | |
| テスト | Vitest 4（client/server）+ Playwright | |
| Lint | ESLint 10 + Prettier 3 | |
| パッケージ管理 | pnpm（`corepack enable`） | Node.js 22.12+ |

### 4.2 追加導入

| パッケージ | 用途 | 備考 |
|---|---|---|
| `@sveltejs/adapter-cloudflare` | adapter-auto から差し替え | `vite.config.ts` の `sveltekit({ adapter })` にアダプタを渡す方式は **SvelteKit 2.62.0 以降が必要**。既存スキャフォールドは 2.63.0 のため要件を満たすが、`package.json` に `"@sveltejs/kit": "^2.63.0"` の下限を明示し、2.62.0 未満への意図しないダウングレードを防ぐ |
| `wrangler` (4.68+) | 開発サーバ・デプロイ・D1マイグレーション | Docker 不要（workerd 同梱） |
| `@cloudflare/workers-types` | `Env` / DO の型 | `wrangler types` が生成する `worker-configuration.d.ts` を併用 |
| `@cloudflare/vitest-pool-workers` | DO / Worker の統合テストを workerd 上で実行 | |
| `valibot` | 入出力スキーマ検証（クライアント・サーバ共有） | D-15 |
| `drizzle-valibot` | D1 スキーマからの検証スキーマ導出 | |
| `fast-check` | ルールエンジン・射影のプロパティテスト | 16.1「射影」テストで使用。devDependency |

**D-15 の根拠（Valibot 採用）**: 同一スキーマをサーバ（Worker のバンドルサイズ制約）とクライアント（初回表示速度）で共有するため、tree-shakable でバンドルが小さいものを選ぶ。`v.strictObject` が既定で未定義キーを拒否するため、企画書21章「未定義項目を無視せず、必要に応じて拒否する」を型定義そのもので満たせる。Zod への差し替えは `src/lib/protocol/` に閉じており容易。

### 4.3 無料プランでの運用上の制約

本プロジェクトは **Cloudflare Workers Free プラン**（初期投資なし）を前提とする。以下は無料プランに固有の制約で、本書の設計に直接影響する。

| 機能 | 無料プランの制約 | 本書での対応 |
|---|---|---|
| D1 | **2026年9月1日より、1日あたりの行読み取り／書き込み上限を超えるとクエリがエラーになる**（超過分は翌日UTC 0時にリセット。[D1 free tier limit enforcement](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/)）。ちょうど本書作成時点で施行済みの制約である | 対戦中の高頻度な読み書きは DO 内蔵 SQLite に閉じ込め、D1 へは触れない設計（12.2）が有効に効く。D1 側は 12.3 のインデックス整備を徹底し、フルスキャンを避ける |
| Durable Objects | 無料プランで利用可能（コミット不要）。ただし DO の compute/storage にも無料枠の上限がある | MVP規模では問題にならない想定。負荷試験（16.3）で無料枠の消費実績を計測する |
| Queues | 無料プランで利用可能だが、**メッセージの最大保持期間は24時間**（有料プランの14日ではない。[Queues free plan](https://developers.cloudflare.com/changelog/post/2026-02-04-queues-free-plan/)）、1日あたり10,000操作まで | 9.2 の archive リトライ設計を「24時間以内に確実に解決する」前提に修正（下記参照） |
| R2 | 無料枠: ストレージ10GB、Class A操作100万/月、Class B操作1,000万/月、エグレス無料 | リプレイ画像・音声の容量とアクセス数をこの枠内に収める設計とし、超過が見込まれる場合はリプレイ保持期間（90日）の短縮を先に検討する |
| Turnstile | 無料 | — |
| Cloudflare Access | 少人数の運営チームであれば無料枠の範囲に収まる見込みだが、正確な無料ユーザー数はデプロイ前にダッシュボードで確認する | 10.4 の管理画面保護に使用 |

**Queue の24時間保持を踏まえた archive リトライの修正（9.2 の補足）**: 有料プランの14日保持を前提にした「DLQ滞留・72時間でアラート」は無料プランでは成立しない。メッセージが24時間以内に失われる可能性があるため、Queue のリトライだけに頼らず、**web Worker の定期実行（Cron Trigger、無料プランで利用可）が `archive_state IN ('pending','failed')` の試合を1時間ごとに直接スキャンし、Queue を介さず DO の export API を直接叩いて再試行**するフォールバックを持つ。これにより Queue メッセージの消失が永続化の失敗に直結しない。

### 4.4 採用しないもの（企画書 13.4 / 35 の確認）

- **Rust / WebAssembly**: 初期は採用しない。ルールエンジンを純粋関数の境界（`applyCommand`）で切っているため、複雑化した際にこの境界ごと差し替えられる。
- **Bevy / 3D**: 採用しない。
- **Docker**: 開発・CI ともに不使用（5章）。

---
