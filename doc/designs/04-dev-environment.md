# 開発環境とリポジトリ構成

> [設計ドキュメント索引](./README.md)

### 5.1 前提

- Node.js 22.12 以上
- `corepack enable` により pnpm を有効化
- Cloudflare アカウント（ローカル開発のみなら未ログインでも可）

Docker は一切使わない。`wrangler` / `vite` が同梱する **workerd**（Cloudflare 本番と同じランタイム）と **Miniflare** がローカルで D1・Durable Objects・R2・Queues をエミュレートするため、コンテナは不要。Playwright のブラウザも `playwright install` でネイティブに入る。

### 5.2 プロセス構成

2プロセスを並行起動する。

```
ターミナル1: pnpm dev:realtime   -> wrangler dev -c workers/realtime/wrangler.jsonc --port 8787
ターミナル2: pnpm dev:web        -> vite dev --port 5173
```

`pnpm dev` は上記2つを同時起動するショートカット（`npm-run-all2` 等のクロスプラットフォームなランナーを使用）。

**同一オリジンの維持**: Vite の dev server proxy で `/ws` を realtime Worker に転送し、開発中も本番と同じ「同一オリジン」を再現する。

```ts
// vite.config.ts（抜粋）
server: {
  proxy: {
    '/ws': { target: 'http://127.0.0.1:8787', ws: true, changeOrigin: false }
  }
}
```

これにより、クライアント側の接続先は開発・本番とも `location.origin` 由来で共通になる。

### 5.3 ローカルの永続データ

- 保存先: `.wrangler/state/`（`.gitignore` 済み）
- リセット: `pnpm dev:reset` = `.wrangler/state` の削除
- SQLite の直接確認: `.wrangler/state/v3/d1/` 配下のファイルを任意の SQLite クライアントで開く

**本番データをローカルへコピーしない**（企画書 22.2）。シードは `scripts/seed.sql` を用意し、`wrangler d1 execute ... --local --file scripts/seed.sql` で投入する。

### 5.4 D1 マイグレーション

drizzle-kit で SQL を生成し、適用は wrangler で行う（ローカル適用にクラウド認証情報を必要としないため）。

```
pnpm db:generate      # drizzle-kit generate  -> drizzle/*.sql
pnpm db:migrate:local # wrangler d1 migrations apply emerald-wani-db --local
pnpm db:migrate:stg   # wrangler d1 migrations apply emerald-wani-db-stg --remote
```

既存の `drizzle.config.ts`（`d1-http` ドライバ）は **リモートのスキーマ確認・Studio 用途に限定**する。ローカル開発が `CLOUDFLARE_ACCOUNT_ID` 等を要求しない構成にすること。

### 5.5 環境変数とシークレット

Workers の規約に合わせ、ローカルのシークレットは `.dev.vars` に置く（`.env` ではない）。

```
# .dev.vars （.gitignore 対象・コミット禁止）
BETTER_AUTH_SECRET="..."
WS_TICKET_SECRET="..."
TURNSTILE_SECRET_KEY="..."
```

- 公開して良い値（`PUBLIC_TURNSTILE_SITE_KEY` 等）のみ `wrangler.jsonc` の `vars` に置く。
- ステージング／本番は `wrangler secret put <NAME> --env <env>` で投入する。ソースにも `wrangler.jsonc` にも秘密情報を書かない（企画書 22.2）。
- **作業項目**: 現在リポジトリ直下に `.env` が存在する。`.gitignore` 対象ではあるが Workers 実行時には読まれないため、`.dev.vars` へ移行し `.env.example` を `.dev.vars.example` に置き換える。`.gitignore` に `.dev.vars` を追加する。

### 5.6 型生成

```
pnpm cf-typegen   # wrangler types -> worker-configuration.d.ts
```

生成された `Env` を `src/app.d.ts` の `App.Platform` に接続し、`event.platform.env.DB` 等を型付けする。

```ts
// src/app.d.ts（追記イメージ）
declare global {
  namespace App {
    interface Platform {
      env: Env;
      cf: CfProperties;
      ctx: ExecutionContext;
    }
  }
}
```

### 5.7 npm scripts（確定案）

| script | 内容 |
|---|---|
| `dev` | web + realtime 同時起動 |
| `dev:web` / `dev:realtime` | 個別起動 |
| `dev:reset` | ローカル状態の初期化 |
| `build` | `vite build`（web）+ realtime の型チェック |
| `check` | `svelte-check` |
| `lint` / `format` | ESLint + Prettier |
| `test:unit` | Vitest（node / browser） |
| `test:workers` | Vitest（`@cloudflare/vitest-pool-workers`、DO テスト） |
| `test:e2e` | Playwright |
| `db:generate` / `db:migrate:local` | マイグレーション |
| `cf-typegen` | `wrangler types` |
| `deploy:web` / `deploy:realtime` | `wrangler deploy`（環境指定） |

---

## リポジトリ構成

```
emerald-wani/
├─ doc/
│  ├─ requirements.md            企画書
│  ├─ design.md                  本書
│  └─ cards.md                   カードマスタ仕様（詳細設計・別途）
├─ src/                          emerald-wani-web（SvelteKit）
│  ├─ routes/
│  │  ├─ +layout.svelte
│  │  ├─ +page.svelte                     トップ
│  │  ├─ (auth)/…                          登録・ログイン
│  │  ├─ (app)/…                           ホーム・デッキ・図鑑・対戦・履歴・設定
│  │  ├─ (admin)/admin/…                   運営管理（経路分離）
│  │  └─ api/v1/…/+server.ts               REST API
│  ├─ lib/
│  │  ├─ game/                  ★ルールエンジン（純粋TS・CF非依存）
│  │  │  ├─ types.ts            MatchState / Lane / CardInstance …
│  │  │  ├─ rng.ts              決定論CSPRNG（HMAC-SHA-256カウンタ）+ Fisher–Yates
│  │  │  ├─ commands.ts         Command 定義
│  │  │  ├─ events.ts           Event 定義
│  │  │  ├─ reducer.ts          applyCommand（唯一の状態遷移点）
│  │  │  ├─ predict.ts          predictView（秘匿情報不要のクライアント予告演出用）
│  │  │  ├─ view.ts             座席視点への射影（秘匿情報の除去）
│  │  │  ├─ engines/            ★ RULE_VERSION ごとの reducer 実装レジストリ（D-25）
│  │  │  │  ├─ registry.ts      ruleVersion -> engine の解決
│  │  │  │  ├─ v2026-09-0/      各版数の reducer スナップショット
│  │  │  │  └─ …
│  │  │  ├─ ai/                 CPU 思考（純粋関数）
│  │  │  └─ cards/              カードマスタ（データ + 効果ハンドラ）
│  │  ├─ protocol/              Valibot スキーマ（REST/WS、クライアント共有）
│  │  ├─ components/            カード・レーン・手札・演出
│  │  ├─ client/                UIストア・WSクライアント・再接続制御
│  │  └─ server/
│  │     ├─ auth.ts             better-auth 構成
│  │     ├─ db/                 Drizzle スキーマ・クエリ
│  │     ├─ api/                guard / ratelimit / audit / error のテンプレート
│  │     └─ ws-ticket.ts        HMAC チケット発行
│  ├─ hooks.server.ts
│  └─ app.d.ts
├─ workers/
│  └─ realtime/                 emerald-wani-realtime
│     ├─ src/
│     │  ├─ index.ts            エントリ（Origin検証・ルーティング）
│     │  ├─ match-room.ts       MatchRoom DO
│     │  ├─ match-queue.ts      MatchQueue DO
│     │  ├─ queue-consumer.ts   Queue consumer（DOからexport取得 → D1 / R2 書き出し → archive通知）
│     │  └─ ws-ticket.ts        HMAC チケット検証（web と共有ロジック）
│     ├─ test/                  vitest-pool-workers
│     └─ wrangler.jsonc
├─ drizzle/                     生成マイグレーション
├─ e2e/                         Playwright
├─ scripts/seed.sql
├─ wrangler.jsonc               emerald-wani-web
├─ vite.config.ts
├─ .dev.vars.example
└─ package.json
```

`workers/realtime` から `src/lib/game/` と `src/lib/protocol/` を import する（`tsconfig.json` の `paths` に `$game/*`・`$protocol/*` を追加）。**依存方向は realtime → lib の一方向のみ**とし、`src/lib/game` から `workers/` を参照してはならない。

---
