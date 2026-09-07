# デプロイ手順（Cloudflare の準備を含む）

> [設計ドキュメント索引](./designs/README.md) / [環境分離](./designs/18-availability.md) / [鍵ライフサイクル](./designs/13-secrets-lifecycle.md)

本書だけを見て、**まっさらな Cloudflare アカウントから本番稼働まで**到達できることを目標にする。
GUI（ダッシュボード）でしかできない作業と、CLI（`wrangler`）で行う作業を分けて書く。

## 0. 確定値

| 項目             | 値                                                           |
| ---------------- | ------------------------------------------------------------ |
| 本番 URL         | `https://emerald-wani.jocarium.productions`                  |
| WebSocket        | `wss://emerald-wani.jocarium.productions/ws/*`               |
| 窓口メール       | `emerald-wani@jocarium.productions`                          |
| 送信元メール     | `no-reply@jocarium.productions`（Resend で検証したドメイン） |
| Worker（web）    | `emerald-wani-web` / stg は `emerald-wani-web-stg`           |
| Worker（実時間） | `emerald-wani-realtime` / stg は `emerald-wani-realtime-stg` |
| D1               | `emerald-wani-db` / stg は `emerald-wani-db-stg`             |
| R2               | `emerald-wani-replays`                                       |
| Queue            | `match-events` / DLQ `match-events-dlq`                      |

コード側の正本は [`src/lib/site.ts`](../src/lib/site.ts)（画面に出す窓口）と
[`static/.well-known/security.txt`](../static/.well-known/security.txt)。

---

## 1. GUI で先に作るもの

`wrangler` はここに挙げた資源を**自動では作らない**（存在しないまま `deploy` すると失敗する）。
Cloudflare ダッシュボード（[dash.cloudflare.com](https://dash.cloudflare.com)）で先に用意する。

### 1.1 ゾーン（DNS）

1. `jocarium.productions` を Cloudflare のゾーンとして追加し、ネームサーバーを切り替える。
2. サブドメイン `emerald-wani` のレコードは**手で作らない**。1.6 の Custom Domain 登録が
   プロキシ済みレコードを自動で作る。

### 1.2 D1

**Workers & Pages → D1 → Create database**

| 名前                  | 用途         | Database ID                            |
| --------------------- | ------------ | -------------------------------------- |
| `emerald-wani-db`     | 本番         | `0f43d043-78ce-4a1a-9449-05f188cd4af7` |
| `emerald-wani-db-stg` | ステージング | `2dc94590-4d7b-4c7a-90eb-d6aed221fee8` |

**作成済み。** 本番の ID は `wrangler.jsonc` と `workers/realtime/wrangler.jsonc` の両方へ
反映済み。stg へデプロイするときは、wrangler の環境ブロック（`env.staging`）を足して
Worker 名と `database_id` を差し替える。

web と realtime で**必ず同じ ID** を使うこと。片方だけ替えると、両者が別の DB を見て、
対戦は動くのに戦績が出ない状態になる。

`database_id` を変えると**ローカルの SQLite も別物になる**（Miniflare は ID ごとに
ファイルを分ける）。変更したら `pnpm db:migrate:local` を流し直すこと。

CLI で作る場合: `npx wrangler d1 create emerald-wani-db`

### 1.3 R2

**R2 → Create bucket** で `emerald-wani-replays` を作る（**作成済み**。S3 API の
エンドポイントは `https://bce0f152c69f3ec8fc56f23c8120077c.r2.cloudflarestorage.com/emerald-wani-replays`
＝アカウント ID `bce0f152c69f3ec8fc56f23c8120077c`）。

アプリからは S3 API ではなく **Worker のバインディング**（`REPLAYS`）で読み書きするため、
S3 のアクセスキーは不要である。S3 エンドポイントは外部ツールから中身を確認したいときだけ使う。

- **公開アクセスは有効にしない**（リプレイは Worker が認可してから配信する。[API とプロトコル](./designs/09-api-protocol.md) 1節）。
- ライフサイクルルールを2つ入れる（**Settings → Object lifecycle rules**）。保持期間の根拠は
  [API とプロトコル](./designs/09-api-protocol.md)と[プライバシーポリシー](../src/routes/privacy/+page.svelte)。

| プレフィックス | ルール      | 理由                                     |
| -------------- | ----------- | ---------------------------------------- |
| `replays/`     | 90日で削除  | リプレイの保持期間                       |
| `exports/`     | 400日で削除 | 週次 D1 エクスポート＝監査ログの保持期間 |

`exports/` を消しすぎると[復元試験](./restore-drill.md)の復元元が無くなる。90日ルールを
バケット全体に掛けないこと。

### 1.4 Queues

**Workers & Pages → Queues → Create queue** で2つ作る（**作成済み**）。名前は完全一致させる。

1. `match-events`
2. `match-events-dlq`（DLQ。`wrangler.jsonc` の `dead_letter_queue` が参照する）

> Queues は**無料プランでも使える**（2026-02-04 から。1日10,000操作まで、メッセージ保持は24時間）。
> 本プロジェクトの想定量は1対戦あたり3操作なので、無料枠で十分に収まる
> （[料金と無料枠](./cost.md)）。

### 1.5 Turnstile

**Turnstile → Add widget**

- Widget mode: **Managed**
- Domain: `emerald-wani.jocarium.productions`（stg のホスト名も追加する）
- 発行される **Site Key**（公開値）と **Secret Key**（秘密）を控える。

### 1.6 Worker のルーティング（デプロイ後に行う）

同一オリジンを維持するため、1つのホスト名を2つの Worker で分ける
（[アーキテクチャ](./designs/02-architecture.md) 3.3）。

```
emerald-wani.jocarium.productions/ws/*  ->  emerald-wani-realtime
emerald-wani.jocarium.productions/*     ->  emerald-wani-web
```

1. `emerald-wani-web` の **Settings → Domains & Routes → Add → Custom domain** で
   `emerald-wani.jocarium.productions` を追加する（DNS レコードは自動生成される）。
2. `emerald-wani-realtime` の **Settings → Domains & Routes → Add → Route** で
   `emerald-wani.jocarium.productions/ws/*` を追加し、ゾーンを選ぶ。
3. **順序が重要**: より限定的なルート（`/ws/*`）が Custom Domain より優先される。
   追加後、`/ws/matches/<uuid>` が realtime に届くことを 6節の確認手順で必ず見る。

### 1.7 Cloudflare Access（管理画面）

[認証・認可設計](./designs/10-auth-and-access.md) 10.4 により、**本番と stg の `/admin/**` は
アプリ層の認可に加えて Access で塞ぐ**。

**Zero Trust → Access → Applications → Add an application → Self-hosted**

- Application domain: `emerald-wani.jocarium.productions`、Path: `admin`
- Policy: Allow / 運営メンバーのメールアドレスを列挙（Include → Emails）
- Session duration: 24時間以下

運営メンバーの入退時は**ここを即日更新する**。アプリ側の `admin` 役割の剥奪だけでは、
ネットワーク層の到達性が残る。

### 1.8 WAF・Rate Limiting Rules

アプリ内のレート制限（`ratelimit` バインディングと `GuestIssuanceGuard`）とは別に、
エッジ側で粗い網を張る（[セキュリティ実装対策](./designs/11-security-controls.md) 11.4）。

**Security → WAF → Rate limiting rules**

| ルール           | 条件                                        | 対応        |
| ---------------- | ------------------------------------------- | ----------- |
| 認証系の総当たり | `/api/auth/*` へ 60秒に30リクエスト超（IP） | 1分ブロック |
| WS 接続の連打    | `/ws/*` へ 60秒に60リクエスト超（IP）       | 1分ブロック |

Managed Ruleset（無料プランの範囲）は既定のまま有効にしておく。

### 1.9 Resend（メール配送）

[メール配送](./email.md) 3節に従い、`jocarium.productions` を Resend で検証する。
SPF / DKIM の CNAME・TXT と、DMARC（`v=DMARC1; p=quarantine; rua=mailto:emerald-wani@jocarium.productions`）を
Cloudflare DNS へ追加する。**DNS の検証が通る前に本番の API キーを投入しない。**

---

## 2. リポジトリ側の差し替え

GUI の作業結果をコードへ反映する。ここを飛ばすと、デプロイは成功するのに本番が
ローカル用の設定で動く。

| ファイル                          | 変更点                                                                                                                                                                                                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wrangler.jsonc`                  | `database_id` を実 ID へ。`vars.ORIGIN` を `https://emerald-wani.jocarium.productions` へ。`vars.ENVIRONMENT` を `production` へ。`vars.EMAIL_FROM` を `エメラルドワニ <no-reply@jocarium.productions>` へ。`vars.PUBLIC_TURNSTILE_SITE_KEY` に Site Key を入れる |
| `workers/realtime/wrangler.jsonc` | `database_id` を実 ID へ（web と同じ値）。`vars.ALLOWED_WS_ORIGINS` を `https://emerald-wani.jocarium.productions` へ                                                                                                                                             |

`ENVIRONMENT` を `production` にすると、Turnstile 未設定・メール配送未設定が
**素通りではなく失敗**になる（フェイルクローズ）。1.5 と 1.9 を先に済ませること。

---

## 3. シークレットの投入

台帳は[鍵ライフサイクル](./designs/13-secrets-lifecycle.md)。値の生成:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

```bash
# web Worker
npx wrangler secret put BETTER_AUTH_SECRET        # S-02
npx wrangler secret put WS_TICKET_SECRET_V1       # S-01（realtime と同じ値）
npx wrangler secret put TURNSTILE_SECRET_KEY      # S-03（1.5 の Secret Key）
npx wrangler secret put RESEND_API_KEY            # S-04
npx wrangler secret put AUDIT_SALT_SECRET         # S-06（realtime と同じ値）
npx wrangler secret put ALERT_WEBHOOK_URL         # 重大度 error 以上の通知先

# realtime Worker（-c で設定ファイルを指定する）
npx wrangler secret put WS_TICKET_SECRET_V1 -c workers/realtime/wrangler.jsonc
npx wrangler secret put AUDIT_SALT_SECRET   -c workers/realtime/wrangler.jsonc
npx wrangler secret put ALERT_WEBHOOK_URL   -c workers/realtime/wrangler.jsonc
```

- `WS_TICKET_SECRET_V1` と `AUDIT_SALT_SECRET` は**2つの Worker で必ず同じ値**にする
  （前者は署名と検証、後者は同日内で監査記録を突き合わせるため）。
- 本番とローカル（`.dev.vars`）で**同じ値を使わない**。

---

## 4. データベースのマイグレーション

```bash
npx wrangler d1 migrations apply emerald-wani-db --remote
```

- 破壊的な変更（列の削除・改名）は、**適用前に Time Travel の復元点を控える**
  （[可用性](./designs/18-availability.md) 15.5「D1 の誤更新」）。
- stg は `pnpm db:migrate:stg`。

---

## 5. デプロイ

**順序が重要**: realtime を先に出す。web は `script_name` で realtime の Durable Object を
参照しており、realtime が存在しないと web のデプロイが失敗する。

```bash
pnpm lint && pnpm check && pnpm test:unit -- --run   # 出す前に落ちるものを潰す
pnpm deploy:realtime                                  # 1. DO / Queue consumer / Cron
pnpm deploy:web                                       # 2. SSR + API（vite build を含む）
```

初回デプロイの後に 1.6（ルーティング）と 1.7（Access）を設定する。

**デプロイは進行中の全 Durable Object を再起動し、WebSocket を切断する**
（[可用性](./designs/18-availability.md) 15.1）。試合状態は DO の SQLite に残るため
失われないが、参加者は一斉に再接続する。**対戦が少ない時間帯に出す。**

---

## 6. デプロイ後の確認

```bash
BASE=https://emerald-wani.jocarium.productions

curl -sI $BASE/home | grep -i "content-security-policy\|strict-transport"   # ヘッダー
curl -s  $BASE/.well-known/security.txt                                     # 窓口
curl -s -o /dev/null -w '%{http_code}\n' $BASE/terms                        # 規約 200
curl -s -o /dev/null -w '%{http_code}\n' $BASE/admin                        # 401 か Access の画面
curl -s -o /dev/null -w '%{http_code}\n' $BASE/ws/matches/00000000-0000-4000-8000-000000000000  # 403/426（=realtime に届いている）
```

`/ws/*` が web 側の 404 を返す場合、1.6 のルート設定が効いていない。

続けて、ステージングに対しては検証スクリプトを一通り流せる。

```bash
EMERALD_WEB_ORIGIN=https://stg.example EMERALD_REALTIME_ORIGIN=https://stg.example pnpm verify:phase7
```

本番に対しては `verify:phase5` / `verify:phase6` を**流さない**（テストデータと
security_event が本番へ入るため）。本番では上の curl とダッシュボードの
Analytics / Logs で確認する。

---

## 7. ロールバック

```bash
npx wrangler deployments list                       # 直近のバージョンを確認
npx wrangler rollback [<version-id>]                # web
npx wrangler rollback [<version-id>] -c workers/realtime/wrangler.jsonc
```

- **ロールバックも DO を再起動する。** 切断と再接続の集中が起きる前提で行う。
- D1 のスキーマはロールバックされない。マイグレーションを伴う変更を戻すときは、
  先に Time Travel（`npx wrangler d1 time-travel restore emerald-wani-db --timestamp=<ISO8601>`）で
  DB を戻す範囲を見積もる。

---

## 8. 公開前チェック

| #   | 項目                                                                  | 確認方法                                |
| --- | --------------------------------------------------------------------- | --------------------------------------- |
| 1   | `database_id` が web / realtime で一致し、実 ID になっている          | 2節                                     |
| 2   | `ENVIRONMENT=production`、`ORIGIN` と `ALLOWED_WS_ORIGINS` が本番 URL | 2節                                     |
| 3   | シークレット6種が両 Worker に入っている                               | `npx wrangler secret list`              |
| 4   | R2 のライフサイクル（`replays/` 90日、`exports/` 400日）              | 1.3                                     |
| 5   | `/admin/**` が Access で保護されている                                | 1.7、6節の curl                         |
| 6   | `security.txt` の `Expires` が1年以上先                               | `pnpm verify:phase7`                    |
| 7   | 規約・プライバシー・セキュリティポリシー・窓口が 200 で開ける         | 6節の curl                              |
| 8   | Turnstile が本番ドメインで動く（ゲスト開始が通る）                    | ブラウザで `/home`                      |
| 9   | 週次エクスポートの Cron が登録されている                              | Worker の Settings → Triggers           |
| 10  | 障害・インシデント時の手順を実施者が把握している                      | [インシデント訓練](./incident-drill.md) |

## 9. 運用の定期タスク

| 周期   | 作業                                                                                 |
| ------ | ------------------------------------------------------------------------------------ |
| 毎週   | 週次エクスポート（Cron）の成功をログで確認                                           |
| 四半期 | [復元試験](./restore-drill.md)、[インシデント訓練](./incident-drill.md)              |
| 年1回  | `security.txt` の `Expires` 更新、シークレットのローテーション（S-01 / S-02 / S-06） |
