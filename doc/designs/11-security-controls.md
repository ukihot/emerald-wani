# セキュリティ実装対策

> [設計ドキュメント索引](./README.md)

### 11.1 HTTP レスポンスヘッダー

`hooks.server.ts` の最終段で一括付与する。

| ヘッダー                       | 値                                                     |
| ------------------------------ | ------------------------------------------------------ |
| `Content-Security-Policy`      | 下記参照（P0修正版）                                   |
| `X-Content-Type-Options`       | `nosniff`                                              |
| `Referrer-Policy`              | `same-origin`                                          |
| `Permissions-Policy`           | `camera=(), microphone=(), geolocation=(), payment=()` |
| `Cross-Origin-Opener-Policy`   | `same-origin`                                          |
| `Cross-Origin-Resource-Policy` | `same-origin`                                          |
| `Strict-Transport-Security`    | `max-age=31536000; includeSubDomains; preload`         |

**CSP の訂正（P0-6）**: 当初案の `default-src 'none'; script-src 'self' 'nonce-…'; style-src 'self' 'nonce-…'` は、実装を進めると2点で破綻する。

1. **`frame-src` が無く Turnstile の iframe が起動しない。** Turnstile は `challenges.cloudflare.com` を `script-src` と `frame-src` の両方に許可する必要がある（[Turnstile CSP](https://developers.cloudflare.com/turnstile/reference/content-security-policy/)）。
2. **`style-src` を nonce のみで縛ると Svelte のトランジションが動かない。** SvelteKit 公式が「多くの Svelte トランジションは動的なインライン `<style>` を生成するため、`style-src` を指定しないか `unsafe-inline` を許可する必要がある」と明記している（[SvelteKit CSP設定](https://svelte.dev/docs/kit/configuration#csp)）。[フロントエンド設計](./17-frontend.md)では Svelte ネイティブのトランジションを演出に使うため、この制約と正面から衝突する。

演出を静的 CSS クラスや Web Animations API に寄せる選択肢もあるが、盤面演出を優先し、**`style-src` にだけ `unsafe-inline` を許容し、`script-src` は nonce 方式を崩さない**方針を採る。攻撃面としては、`unsafe-inline` の対象を `style-src` に限定する限り、実行可能なスクリプトの持ち込みには寄与しない（インラインスタイルによる UI 改ざんは残るが、Svelte がエスケープする DOM 構造の中でのみ発生し、`{@html}` 禁止と合わせてリスクは限定的）。

```
default-src 'none';
script-src 'self' 'nonce-<NONCE>' https://challenges.cloudflare.com;
style-src 'self' 'unsafe-inline';
frame-src https://challenges.cloudflare.com;
img-src 'self' data: <アセット配信元>;
connect-src 'self';
font-src 'self';
frame-ancestors 'none';
base-uri 'none';
form-action 'self';
object-src 'none';
```

CSP は SvelteKit の `kit.csp`（`mode: 'nonce'`）で `script-src` の nonce を自動付与する。WebSocket は同一オリジン `/ws/*` なので `connect-src 'self'` のままで足りる。管理画面（`/admin/**`）は Turnstile を使わないため、そのレイアウトでは `script-src` / `frame-src` から `challenges.cloudflare.com` を除いた、より厳格な CSP を別途適用する。

### 11.2 WebSocket セキュリティ（D-04 / D-24）

**チケット方式（検証主体は MatchRoom DO。3.5参照）**

```
POST /api/v1/matches/{matchId}/ws-ticket   （Cookie 認証・Origin 検証済み）
  → { ticket: "<payload_b64url>.<hmac_b64url>" }

payload = { kid, mid, uid, seat, jti(UUIDv7), exp(now+60s), rv(RULE_VERSION) }
hmac    = HMAC-SHA256(secret[kid], rawBytesOf(payload))   -- 署名対象はpayloadのraw bytes（JSON文字列化前ではなくシリアライズ後のバイト列そのもの）
```

- **チケットは URL クエリに載せない。** WebSocket 接続確立後、クライアントが最初に送る `hello` フレームのボディに入れる。5秒以内に有効な `hello` が来なければ切断する。これによりアクセスログ・Referer・ブラウザ履歴に資格情報が残らない。
- **検証は `MatchRoom` DO 自身が行う（realtime Worker は行わない）。** 署名・有効期限・`mid` の一致を DO が検証し、`jti` の **単回使用** を `used_ticket` テーブルで強制する。3.5 で述べたとおり、Worker がチケットを検証してから DO へ接続を渡すモデルは Hibernation API の標準フローと両立しないため採らない。
- **鍵ローテーション**: `WS_TICKET_SECRET` は `kid`（鍵ID）付きで複数世代を両 Worker の secret に保持する（例 `WS_TICKET_SECRET_V1` / `WS_TICKET_SECRET_V2`）。チケットの `kid` で参照鍵を選択する。鍵をローテートする際は新鍵を追加してから **旧鍵を最低 exp の最大値（60秒）+ 猶予分だけ残す**（推奨: 旧鍵は発行停止から10分間は検証のみ有効に保つ）。両 Worker には同じ鍵セットを同時に投入する。

**接続時（realtime Worker が担当）・接続後（DO が担当）の検証**

| 項目                              | 主体            | 内容                                                                                                   |
| --------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------ |
| Origin 検証                       | realtime Worker | `Origin` が許可リストに一致しない接続は 403 で拒否                                                     |
| Upgrade 検証                      | realtime Worker | `Upgrade: websocket` 以外は 426                                                                        |
| IP 粗いレート制限                 | realtime Worker | Upgrade 要求そのものの頻度を制限（DoS対策。チケットの正当性は見ない）                                  |
| チケット署名・有効期限・`mid`一致 | MatchRoom DO    | `hello` フレームで検証。不正なら close                                                                 |
| `jti` 単回使用                    | MatchRoom DO    | `used_ticket` に存在すれば拒否                                                                         |
| 参加者確認                        | MatchRoom DO    | チケットの `uid` が `seat` テーブルに存在すること                                                      |
| メッセージ形式                    | MatchRoom DO    | Valibot `strictObject`。未定義キーがあれば拒否                                                         |
| メッセージサイズ                  | MatchRoom DO    | 8 KB 上限。超過は即切断                                                                                |
| 送信頻度                          | MatchRoom DO    | 20メッセージ / 10秒。超過は `E_RATE_LIMITED`、連続超過で切断                                           |
| 無効メッセージ                    | MatchRoom DO    | 連続5回で切断し、`security_event` に記録                                                               |
| 同時接続数                        | MatchRoom DO    | 1試合1座席あたり有効接続は1本のみ。新しい接続が確立され認証に成功した時点で旧接続を切断する（9.2参照） |
| 終局後                            | MatchRoom DO    | 行動要求はすべて `E_MATCH_FINISHED`                                                                    |

### 11.3 CSRF

- 状態変更 API（POST/PUT/DELETE）は `SameSite=Lax` Cookie に加えて **Origin ヘッダー検証** を行う。
- SvelteKit の form actions は組み込みの CSRF チェック（`csrf.checkOrigin`）を有効のままにする。
- WS はチケット方式で Cookie を使わないため、CSRF の対象外。

### 11.4 レート制限（D-14 / D-29）

**訂正（P0-7）**: 当初案の `RL_GUEST: 3 / 3600秒` は Workers の `ratelimit` バインディングでは設定できない。同バインディングの `period` は **10秒か60秒のみ**を受け付け、しかも **ロケーションごとに独立したカウンタを持つ eventually consistent な実装**であり、正確な回数制限のための機構ではない（[Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)）。「1時間に3回まで」という厳密な制限をこのバインディングだけで実現することはできない。

Cloudflare の3層＋専用DOの4層で守る。

| 層             | 手段                             | 対象                                             | 特性                                                                           |
| -------------- | -------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------ |
| エッジ         | WAF ルール / Rate Limiting Rules | IP 単位の粗い制限、既知の悪性トラフィック        | 10秒〜1日の幅広い期間に対応（プラン依存）                                      |
| Worker         | `ratelimit` バインディング（GA） | ユーザ単位・エンドポイント単位の**バースト**制限 | `period` は10秒か60秒のみ。ロケーションごとのeventually consistentなカウンタ   |
| Worker + D1/DO | ゲスト発行の**厳密な**時間窓制限 | IP・端末指紋単位                                 | `ratelimit`バインディングでは表現できない1時間単位の制限を専用DOで実装（D-29） |
| DO             | 接続内カウンタ                   | WS メッセージ頻度                                | DO内メモリでの正確なカウント                                                   |

Worker のレート制限バインディング（`ratelimit`。バースト制限のみ、設定案）

| バインディング    | 対象                     | キー                  | 制限（period は 10 か 60 のみ）                       |
| ----------------- | ------------------------ | --------------------- | ----------------------------------------------------- |
| `RL_AUTH`         | ログイン・登録・再設定   | IP + メールのハッシュ | 10 / 60秒                                             |
| `RL_GUEST_BURST`  | ゲスト発行の瞬間的な連打 | IP                    | 3 / 60秒（1時間の厳密な上限は下記の専用DOで別途管理） |
| `RL_MATCHMAKING`  | enqueue                  | userId                | 10 / 60秒                                             |
| `RL_REPORT_WRITE` | 通報作成                 | userId                | 10 / 60秒                                             |
| `RL_WS_TICKET`    | チケット発行             | userId                | 20 / 60秒                                             |
| `RL_API_READ`     | 一般 GET                 | userId                | 300 / 60秒                                            |

**ゲスト発行の1時間上限（D-29）**: `ratelimit` バインディングでは表現できないため、`GuestIssuanceGuard` という軽量な専用 DO（`idFromName(ipHash)`）を web Worker 側に追加し、内蔵 SQLite に「直近1時間の発行タイムスタンプ」を保持してスライディングウィンドウで厳密に3回/時間を強制する。加えて、IP 単体は VPN・共有NATで信頼性が低いため、次のシグナルを組み合わせて判定する。

- Turnstile の検証結果（`success` かつ risk スコアが許容範囲内）
- IP を 12.2 の方式でハッシュ化した値（生IPは保持しない）
- 端末に残る既存の better-auth セッション Cookie の有無（既に有効なアカウントを持つ端末からの追加ゲスト発行は不審とみなす）
- 短時間の異常パターン（同一 User-Agent からの高頻度リクエスト等）を `security_event` に記録し、閾値超過でその IP ハッシュを一時ブロックリストへ追加する

**Turnstile** は登録・ログイン・パスワード再設定・ゲスト発行に適用する。トークンは5分で失効し単回使用のため、サーバ側 siteverify を必ず行う。

### 11.5 入力検証（D-15）

- すべての REST ボディ／クエリ／パスパラメータ、および全 WS メッセージに Valibot スキーマを定義する。
- `v.strictObject` を既定とし、**未定義キーがあれば拒否** する（無視しない）。
- 数値は範囲、文字列は長さ、配列は件数、列挙値は許可リストを必ず指定する。

| 項目              | 上限             |
| ----------------- | ---------------- |
| 表示名            | 16文字           |
| 布陣配列          | 8要素            |
| 一覧APIの `limit` | 50               |
| 招待コード        | 8文字 `[A-Z2-9]` |
| WS メッセージ     | 8 KB             |

### 11.6 XSS / インジェクション

- Svelte の既定エスケープに任せ、**`{@html}` を使わない**（ESLint ルールで禁止する）。
- SQL は Drizzle のパラメータ化クエリのみ。文字列連結による SQL を作らない。
- 表示名は保存時に正規化（Unicode NFKC、制御文字・ゼロ幅文字の除去、前後空白のトリム）を行う。
- ユーザ入力を含む値でリダイレクト先を決めない（オープンリダイレクト対策）。リダイレクトは許可パスの列挙から選ぶ。

### 11.7 エラー応答

- 本番のエラー応答は `{ error: { code, message } }` のみ。スタックトレース・SQL・内部パスを含めない。
- ログイン失敗は成功／失敗を区別できない汎用文言に統一する（アカウント列挙対策）。
- `code` は機械可読な列挙値、`message` は i18n キーに対応する短文。
- 本番ではソースマップを公開しない（`build.sourcemap: 'hidden'`）。

---

## 11.8 通常利用者に見えにくい不正対策

Bot 対策やレート制限を、**通常の利用者へ一律に負担をかける形で実装しない。** [設計原則](./01-principles.md)の「すぐ遊べることもセキュリティ要件」に従い、リスクに応じて段階的に強化する。

### 11.8.1 通常時の体験

- Turnstile は **Managed モード**を使う。問題のない利用者はほぼ無操作で通過する（多くの場合チェックボックスすら表示されない）。
- 「すぐ遊ぶ」からゲスト発行までの間に、利用者が入力する項目は**ゼロ**。
- 対戦中の操作に追加の確認を挟まない。レート制限の閾値（[11.4](#114-レート制限d-14--d-29)）は、人間の操作速度の数倍に設定してあり、通常のプレイで到達しない。

### 11.8.2 段階的な強化

次の兆候を検出した場合に**限り**、追加の負荷をかける。

| 兆候                   | 検出方法                                                                 | 適用する措置                                                 |
| ---------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------ |
| 短時間の大量ゲスト発行 | 専用 DO による1時間ウィンドウの計数（[DO設計](./07-durable-objects.md)） | Turnstile の再提示 → 発行の待機時間挿入 → 一定時間の発行停止 |
| 大量切断               | 同一 `user_id` / `ip_hash` の切断率                                      | マッチング参加前の追加確認                                   |
| 不正な対戦操作の連発   | 1試合内の `E_FORBIDDEN` / `E_NOT_YOUR_TURN` 等の件数                     | WS 接続の切断 → 一定時間のマッチング制限                     |
| 異常なリクエスト頻度   | `ratelimit` バインディングと DO 内カウンタ                               | 429 応答 → 一時的な機能制限                                  |
| 操作傾向の異常         | 行動間隔の分散が極端に小さい（人間らしくない規則性）                     | 記録のみ（即座に制限しない。誤検知が起きやすいため）         |

措置の強度は[監視](./14-observability.md) 4節の5段階に従い、**自動処理で到達してよいのは段階3（一時的な機能制限）まで**とする。段階4以上（アカウント停止）は人間が承認する。

### 11.8.3 判定に用いるシグナル

**IP アドレスだけで恒久的な停止を決定しない。** 共有 NAT、モバイル回線、VPN により、無関係な利用者を巻き込むためである。次を組み合わせて判定する。

| シグナル                     | 用途                                                     | 注意                                                                      |
| ---------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------- |
| 匿名ユーザーID（UUIDv7）     | 個々のゲストの追跡                                       | Cookie 消失で変わるため、単独では不十分                                   |
| 日次ソルトで HMAC 化した IP  | 短期間の同一性判定                                       | **生 IP は保存しない。** 日次ローテートにより長期追跡を意図的に不能にする |
| 既存セッション Cookie の有無 | 既にアカウントを持つ端末からの追加ゲスト発行を不審と判定 | 正当な家族共有もあるため補助的に使う                                      |
| User-Agent の要約            | 同一クライアントの傾向把握                               | 生値は保存せずハッシュ化した要約のみ                                      |
| 操作傾向                     | Bot らしい規則性の検出                                   | 単独で制裁の根拠にしない                                                  |
| Turnstile の検証結果         | Bot 判定の主要根拠                                       | サーバ側 siteverify を必ず行う                                            |

複数のシグナルが同時に異常を示した場合にのみ強い措置へ進む。単一シグナルでの制裁は誤検知率が高く、[異議申立て](./15-incident-response.md)の負荷を増やすだけになる。

### 11.8.4 通報とブロック

- **ゲストも通報の対象とし、ゲストからの通報も受け付ける。** 「ゲストだから通報できない・されない」状態は、悪質な行為をゲスト経由へ誘導する。
- 大量通報による嫌がらせを防ぐため、次を考慮する。
  - 通報頻度の上限（1ユーザーあたり1日10件など）
  - 通報者の信頼度（過去の通報が妥当と判断された比率）
  - **同一対象への複数通報を1件として扱い、通報件数の多さだけを制裁根拠にしない**（組織的な虚偽通報への耐性）
- 通報は自動制裁に直結させず、[監視](./14-observability.md)の記録を経て人間が判断する。
