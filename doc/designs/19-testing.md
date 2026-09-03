# テスト方針

> [設計ドキュメント索引](./README.md)


### 16.1 レイヤ別

| レイヤ | ツール | 対象 |
|---|---|---|
| ルールエンジン | Vitest（node、ブラウザ不要） | カード単体効果、組み合わせ、ターン境界、同時効果、山札切れ、勝敗判定 |
| 射影 | Vitest + **`fast-check`**（プロパティテスト） | **相手の手札・デッキ順・シードが射影結果に絶対に含まれないこと**（`project` と `projectEvent` の両方、および R2 の座席別射影版に対して） |
| 決定論再現 | Vitest（node） | `command_log` を先頭から再実行すると、同じ `rev`・同じ最終状態・同じ RNG カウンタに到達すること |
| 版数互換 | Vitest（node） | 過去の `RULE_VERSION` で記録した `command_log` が、現在のコードのレジストリ経由で同じ結果を再現できること（8.4） |
| DO / Worker | `@cloudflare/vitest-pool-workers`（workerd 上） | `hello` 未送信での切断、無効チケット、二重送信、古い rev、他人の試合への操作、終局後の操作、alarm、再接続、ハイバネーション復帰、`archive_state` が `archived` になるまで削除されないこと |
| API | Vitest + ローカル Worker | 認証・認可・入力検証・レート制限 |
| コンポーネント | Vitest browser mode（Playwright provider） | カード表示、手札、盤面 |
| E2E | Playwright | 登録 → デッキ作成 → マッチ → 対戦 → 履歴 の一連 |

Docker は使わない。`vitest-pool-workers` は workerd をそのまま起動する。

### 16.2 セキュリティテスト（企画書 30.2 のチェックリスト化）

以下を **自動テストとして常時実行** する。手動レビュー任せにしない。

- 未認証で保護 API を叩く → 401
- 他人のデッキ／履歴／リプレイを取得 → 404
- 一般ユーザで管理 API → 404/403
- WS: `hello` を5秒以内に送らない → 切断
- WS: チケットなし／期限切れ／他試合のチケット／使用済みチケット（`jti` 再利用）／失効した `kid` の鍵で署名 → 拒否
- WS: 同一座席で2本目の接続が成功したとき、1本目が確実に切断されること
- WS: 相手のターンに行動 → `E_NOT_YOUR_TURN`
- WS: 手札にないカードを使用 → `E_CARD_NOT_IN_HAND`
- WS: 活力不足 → `E_INSUFFICIENT_RESOURCE`
- WS: 同一 `actionId` の再送 → 二重適用されない
- WS: 古い `baseRev` → `E_STALE_REV`
- WS: 未定義キー付きメッセージ → 拒否
- WS: 8KB 超・高頻度送信 → 切断
- 終局後の行動要求 → `E_MATCH_FINISHED`
- ログイン失敗の応答が、存在するアカウントとしないアカウントで区別できないこと
- ログイン後にセッション ID が変わること
- パスワード変更で他セッションが失効すること
- レスポンスヘッダーに CSP 等が付与されていること
- エラー応答にスタックトレース・SQL が含まれないこと
- 各種ログにメールアドレス・トークンが出力されていないこと

### 16.3 負荷試験（フェーズ6）

同時ログイン、同時マッチング、同時対戦、WS 同時接続、対戦開始時の集中、大量の無効操作、再接続の集中、ログ書き込み、カード画像の集中取得。**加えて、デプロイによる全 DO 再起動（8.4）を模擬し、進行中の試合が一斉に切断された際の再接続の集中に耐えられることを確認する。** また無料プランの日次上限（4.3）に対する消費実績を計測し、想定同時対戦数での D1 行読み書き・Queue 操作数を見積もる。目標値は公開前に設定する。

### 16.4 CI

GitHub Actions（Docker 不使用。`ubuntu-latest` に Node をセットアップするのみ）で `lint` → `check` → `test:unit` → `test:workers` → `build` → `test:e2e` を実行する。依存関係の脆弱性検査（`pnpm audit` + Dependabot）を週次で回す（企画書 15.1「依存関係の継続的な更新」）。

---

## 16.5 セキュリティ要求とテストの対応

**「認可を実装した」という記述は完了条件にならない。** 各対策に識別子を与え、実装箇所・確認方法・自動テスト・運用上の証跡を対応付ける。下表を実装時に埋め、空欄のまま次のフェーズへ進まない。

### 16.5.1 対応表の書式

| 列 | 内容 |
|---|---|
| ID | `SR-<領域>-<連番>` |
| 対策 | 何を実施するか |
| 保護目的 | [P-1〜P-5](./01-principles.md) のどれを守るか |
| 脅威 | 対応する[脅威モデル](./12-threat-model.md)の ID |
| 実装箇所 | ファイルパス |
| 合格条件 | **具体的に何が起きなければ合格か** |
| 自動テスト | テストファイル名 |
| 運用証跡 | 監査ログの種別、監視項目 |

### 16.5.2 主要なセキュリティ要求

| ID | 対策 | 保護目的 | 脅威 | 合格条件（具体的に書く） | 自動テスト |
|---|---|---|---|---|---|
| SR-AUTHZ-01 | リソース所有者の検証 | P-2 | T-AUTH-02 | **他人の `deck_id` を指定した GET/PUT/DELETE が 404 を返す**（403 でも 200 でもない） | `api/decks.spec.ts` |
| SR-AUTHZ-02 | 対戦参加者の検証 | P-1 P-2 | T-GAME-01 | **参加していない試合の `ws-ticket` 発行が 404 を返す** | `api/ws-ticket.spec.ts` |
| SR-AUTHZ-03 | 管理APIの分離 | P-2 | T-AUTH-04 | **一般ユーザーのセッションで `/api/v1/admin/*` が 404 を返す** | `api/admin-guard.spec.ts` |
| SR-SECRET-01 | 手札の秘匿 | P-5 | T-GAME-02 | **`project(state, 0)` の戻り値を全走査して、座席1の手札の `cardId` が1つも出現しない**（`fast-check` で1000ケース以上） | `game/view.property.spec.ts` |
| SR-SECRET-02 | イベントの秘匿 | P-5 | T-GAME-02 | **`projectEvent(e, 0)` の戻り値に、座席1のみが知りうる情報が含まれない** | `game/view.property.spec.ts` |
| SR-SECRET-03 | シードの非開示 | P-5 | T-GAME-02 | **WS の全送信フレームと REST の全レスポンスを走査して `seed` が出現しない** | `do/match-room.spec.ts` |
| SR-SECRET-04 | リプレイの射影 | P-5 | T-DATA-01 | **座席0向けリプレイに座席1の手札 `cardId` が含まれない。射影版が存在しない場合は配信が拒否される** | `queue/replay-export.spec.ts` |
| SR-TICKET-01 | チケットの単回使用 | P-2 | T-GAME-01 | **同一 `jti` の2回目の `hello` が拒否され、接続が閉じられる** | `do/ws-auth.spec.ts` |
| SR-TICKET-02 | チケットの有効期限 | P-2 | T-GAME-01 | **`exp` を過ぎたチケットでの `hello` が拒否される** | `do/ws-auth.spec.ts` |
| SR-TICKET-03 | 未認証接続の切断 | P-2 | T-GAME-01 | **`hello` を送らない接続が5秒で切断される** | `do/ws-auth.spec.ts` |
| SR-TICKET-04 | 鍵ローテーション | P-2 | T-INFRA-02 | **失効した `kid` で署名されたチケットが拒否され、`security_event` に記録される** | `do/ws-auth.spec.ts` |
| SR-IDEM-01 | 行動の冪等性 | P-3 | T-GAME-01 | **同一 `actionId` の再送で rev が増えず、盤面が変化しない** | `do/match-room.spec.ts` |
| SR-IDEM-02 | 古い状態からの操作 | P-3 | T-GAME-01 | **`baseRev` が現在値と異なる `act` が `E_STALE_REV` で拒否される** | `do/match-room.spec.ts` |
| SR-LOG-01 | 機密値の非出力 | 機密性 | T-DATA-04 | **全ログ出力を走査して、メールアドレス・トークン・チケット・Cookie が含まれない** | `server/logging.spec.ts` |
| SR-LOG-02 | 監査ログの追記専用 | P-4 | T-DATA-03 | **`security_event` / `admin_audit` を更新・削除する API が存在しない**（ルート走査で確認） | `api/audit-immutable.spec.ts` |
| SR-HDR-01 | セキュリティヘッダー | 機密性 | — | **全レスポンスに CSP・`nosniff`・`frame-ancestors 'none'` が付与される。CSP に `frame-src https://challenges.cloudflare.com` が含まれる** | `api/headers.spec.ts` |
| SR-ERR-01 | エラーの情報漏えい防止 | 機密性 | — | **本番モードのエラー応答にスタックトレース・SQL・内部パスが含まれない** | `api/errors.spec.ts` |
| SR-ENUM-01 | アカウント列挙の防止 | 機密性 | T-AUTH-01 | **存在するメールと存在しないメールで、ログイン失敗の応答本文・ステータス・応答時間の分布が区別できない** | `api/auth-enum.spec.ts` |
| SR-RATE-01 | ゲスト発行の制限 | P-1 | T-GAME-04 | **同一 `ip_hash` からの4件目のゲスト発行が1時間以内に拒否される**（専用 DO 経由） | `do/guest-guard.spec.ts` |
| SR-GUEST-01 | ゲストの権限同等性 | P-1 | — | **ゲストセッションでも、本登録ユーザーと同じ認可検証が適用される**（ゲスト用の緩い経路が存在しない） | `api/guest-parity.spec.ts` |

### 16.5.3 OWASP ASVS の参照

Web アプリ全体の確認基準として [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/) を参照する。MVP では **Level 1 を全体の基準**とし、次の領域は **Level 2 相当**まで確認する。

| 領域 | 対象 | 理由 |
|---|---|---|
| 認証（ASVS V2） | ログイン、セッション、パスワード、MFA | アカウント侵害の影響が大きい |
| アクセス制御（ASVS V4） | 認可ガード、管理画面 | 水平・垂直の権限昇格を防ぐ |
| 個人情報の保護（ASVS V8） | メールアドレス、IP、削除処理 | 法令上の要求に関わる |
| 検証・サニタイズ（ASVS V5） | 全入力、`announcement.body_md` の描画 | XSS とインジェクションの主経路 |
| 通信（ASVS V9） | HTTPS/WSS の強制、チケット伝送 | — |
| ログと監査（ASVS V7） | 監査ログ、機密値の非出力 | P-4 追跡可能性 |

ASVS の各項目に対する適合・非適合・非該当の判定を、フェーズ5で一覧として記録する。**非適合を「未対応」のまま残す場合は、[脅威モデル](./12-threat-model.md)に残留リスクとして受容記録を残す。**

### 16.5.4 リプレイ配信の重点確認

リプレイは「他人の秘匿情報を含みうるデータを、認可のうえ配信する」という本サービスで最も危険な経路であるため、次を個別に確認する。

- 参加していない試合のリプレイが取得できないこと（SR-AUTHZ-01 と同様に 404）
- 配信されるのが**座席別射影版**であり、運営用完全版が誤って配信されないこと
- 射影版が未生成の試合で、完全版へのフォールバックが起きないこと（配信拒否が正しい挙動）
- URL の推測（`match_id` の総当たり）が現実的でないこと（UUIDv7 の採用）

