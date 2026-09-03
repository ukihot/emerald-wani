# エメラルドワニ 基本設計

- 版数: 1.2
- 作成日: 2026-09-03（1.0）／改訂: 2026-09-03（1.1, 1.2）
- 対象: [`doc/requirements.md`](../requirements.md)（企画書）フェーズ1〜4のMVP
- 前提: **Cloudflare Workers Free プラン**（初期投資なし）。無料プラン固有の制約は [技術スタックとプラン制約](./03-tech-stack.md) を参照。
- 位置づけ: 企画書の「36. 今後の決定事項」を含む未決事項を確定し、実装に着手できる粒度まで基本設計を落とし込む。詳細設計（個々のカード効果仕様・画面ワイヤー）は本設計を親として別途作成する。

## ドキュメント構成

版数 1.2 で単一ファイル（`doc/design.md`）から本フォルダへ分割した。1ファイルが肥大化し、古い記述が訂正されないまま残る事態を避けるため、**1トピック1ファイル**を維持する。新しい観点を追加する際は既存ファイルを際限なく膨らませず、原則として新規ファイルを追加すること。

### 基盤

| ファイル | 内容 |
|---|---|
| [01-principles.md](./01-principles.md) | 設計原則、**保護目的（公平性・真正性・一貫性・追跡可能性・秘匿性）**、「すぐ遊べること」をセキュリティ要件として扱う方針 |
| [02-architecture.md](./02-architecture.md) | 2 Worker 構成、WebSocket 接続の所有者、Worker の責務分界 |
| [03-tech-stack.md](./03-tech-stack.md) | 採用技術の確定版、**無料プランでの運用上の制約** |
| [04-dev-environment.md](./04-dev-environment.md) | Docker 不使用の開発環境、リポジトリ構成 |

### ゲームとサーバ

| ファイル | 内容 |
|---|---|
| [05-game-rules.md](./05-game-rules.md) | 盤面・資源・ターン進行・勝利条件・キーワード能力の確定仕様 |
| [06-rule-engine.md](./06-rule-engine.md) | `applyCommand`、Command/Event モデル、射影、ルール版数レジストリ |
| [07-durable-objects.md](./07-durable-objects.md) | MatchRoom / MatchQueue / GuestIssuanceGuard、行動処理、永続化 |
| [08-data-model.md](./08-data-model.md) | D1 スキーマとインデックス |
| [09-api-protocol.md](./09-api-protocol.md) | REST API、WebSocket プロトコル、リプレイの保存形式 |

### セキュリティ

| ファイル | 内容 |
|---|---|
| [10-auth-and-access.md](./10-auth-and-access.md) | 認証方式、ゲストから本登録への昇格、認可の実装テンプレート、管理者 |
| [11-security-controls.md](./11-security-controls.md) | CSP、WS セキュリティ、**リスクに応じて段階的に強化する不正対策**、入力検証 |
| [12-threat-model.md](./12-threat-model.md) | **脅威モデルとリスク管理、残留リスクの受容記録** |
| [13-secrets-lifecycle.md](./13-secrets-lifecycle.md) | **鍵・シークレットの棚卸し、ローテーション、緊急失効** |
| [14-observability.md](./14-observability.md) | **監査ログ、監視対象、異常検知の警告基準と通知先** |
| [15-incident-response.md](./15-incident-response.md) | **インシデント対応、証拠保全、アカウント停止と異議申立て** |
| [16-supply-chain.md](./16-supply-chain.md) | **依存関係・CI/CD・デプロイ権限の保護** |
| [20-vuln-disclosure.md](./20-vuln-disclosure.md) | **脆弱性の受付窓口と継続的改善** |

### 体験・運用・計画

| ファイル | 内容 |
|---|---|
| [17-frontend.md](./17-frontend.md) | 画面構成、モノクローム＋エメラルドの配色方針、Svelte ネイティブ演出 |
| [18-availability.md](./18-availability.md) | 障害対策、**RPO/RTO と復元試験**、環境分離、**サービス終了時の扱い** |
| [19-testing.md](./19-testing.md) | テスト方針、**セキュリティ要求とテストの対応（OWASP ASVS 参照）** |
| [21-roadmap.md](./21-roadmap.md) | 実装フェーズと未決事項 |
| [99-references.md](./99-references.md) | 参考資料 |

### 章番号の見方

各ファイル内の `3.5` `9.2` のような節番号は、版数 1.1 までの単一ファイル時代の章立てを引き継いでいる。ファイル間の相互参照は節番号ではなくファイル名リンクで行う。

---

## 設計判断サマリ

本設計で確定した主要な判断。根拠は各ドキュメントで詳述する。

| ID | 決定事項 | 確定内容 | 章 |
|---|---|---|---|
| D-01 | Worker構成 | **2 Worker 分割**（`emerald-wani-web` / `emerald-wani-realtime`） | [3](./02-architecture.md) |
| D-02 | DO の呼び出し方式 | **fetch ベース**（RPC は使わない） | [3.4](./02-architecture.md) |
| D-03 | WebSocket 経路 | 同一オリジン `/ws/*` を Routes で realtime Worker へ | [3.3](./02-architecture.md) |
| D-04 | WS 認証 | **短命 HMAC チケット**。URLに載せず、接続後の最初のフレームで送信。**検証は MatchRoom DO 自身が行う**（Worker は Origin/Upgrade/粗いレート制限のみ） | [11.2](./11-security-controls.md) |
| D-05 | 開発環境 | Docker 不使用。`wrangler dev`（workerd）＋ `vite dev` の2プロセス | [5](./04-dev-environment.md) |
| D-06 | 盤面モデル | **3レーン縄張り制** | [7.1](./05-game-rules.md) |
| D-07 | 勝利条件 | 相手リーダーHP 20 → 0 | [7.5](./05-game-rules.md) |
| D-08 | 資源 | 「活力」。初期1、毎ターン上限+1、最大10 | [7.3](./05-game-rules.md) |
| D-09 | デッキ | 30枚固定 / 同名3枚まで / 初期24種 | [7.6](./05-game-rules.md) |
| D-10 | ターン時間 | 90秒。超過で自動ターン終了。3連続で敗北 | [7.4](./05-game-rules.md) |
| D-11 | マリガン | 先攻3枚・後攻4枚＋「濁流」トークン。1回だけ任意枚数を引き直し | [7.4](./05-game-rules.md) |
| D-12 | 認証 | ゲスト（匿名）+ 本登録への昇格。better-auth `anonymous` プラグイン | [10.1](./10-auth-and-access.md) |
| D-13 | 管理者 | better-auth `admin` + `two-factor`（MFA必須）、経路分離 | [10.4](./10-auth-and-access.md) |
| D-14 | Bot対策 | Turnstile（better-auth `captcha` プラグイン）+ `ratelimit` バインディング | [11.4](./11-security-controls.md) |
| D-15 | 入力検証 | **Valibot**。`strictObject` で未定義項目を拒否 | [11.5](./11-security-controls.md) |
| D-16 | カードマスタ | **コード同梱**（`RULE_VERSION` で固定）。D1 は配布・停止状態のみ保持 | [8.4](./06-rule-engine.md) |
| D-17 | 対戦の正 | MatchRoom DO の内蔵 SQLite | [9.2](./07-durable-objects.md) |
| D-18 | リプレイ | R2 に gzip NDJSON。D1 はポインタのみ | [13.3](./09-api-protocol.md) |
| D-19 | 集計・監査 | Queues 経由で非同期に D1 / R2 へ書き出し | [13.3](./09-api-protocol.md) |
| D-20 | ID 方式 | UUIDv7（連番禁止） | [9.5](./07-durable-objects.md) |
| D-21 | マッチング通知 | 1秒ポーリング（MVP）。将来 WS/SSE に置換 | [9.4](./07-durable-objects.md) |
| D-22 | 配色 | **モノクローム基調＋エメラルド単色アクセント**。エメラルド＝「自分が操作できるもの」 | [14.2](./17-frontend.md) |
| D-23 | アニメーション | **Svelte ネイティブ機能を主軸**（`crossfade` / `flip` / `Spring` / `Tween` / カスタム `css` トランジション） | [14.4](./17-frontend.md) |
| D-24 | WS接続の所有 | **MatchRoom DO が Upgrade 要求を直接受理**し、自ら `hello` を検証する。realtime Worker は接続を中継しない | [3.5 / 9.2](./02-architecture.md) |
| D-25 | ルール版数の互換性 | `RULE_VERSION` ごとに **reducer 実装をレジストリで多版数保持**。デプロイで進行中 DO も再起動される前提で再接続プロトコルを持つ | [8.4](./06-rule-engine.md) |
| D-26 | rev とイベントの関係 | rev は **受理した Command 単位**で1増加。Event の主キーは `(rev, event_seq)` の複合キー | [8.2 / 9.2](./06-rule-engine.md) |
| D-27 | 対戦ログの永続化経路 | Queue には `matchId` のみを送る。consumer が DO の export API から取得して R2/D1 へ保存し、**archive 完了を DO へ通知してから** DO の状態を削除する | [13.3](./09-api-protocol.md) |
| D-28 | クライアント楽観更新 | クライアントは秘匿情報を要する `applyCommand` を実行しない。**予告演出（`predictView`）専用の軽量関数**を別に持つ | [8.5](./06-rule-engine.md) |
| D-29 | ゲスト発行のレート制限 | `ratelimit` バインディングは60秒のバースト制限のみに使う。**1時間単位の厳密な上限は専用 DO** で管理する | [11.4](./11-security-controls.md) |
| D-30 | 決定論乱数 | シャッフル・ランダム効果には **HMAC-SHA-256 カウンタ方式**の決定論 CSPRNG を使う（xoshiro128\*\* は不使用） | [9.5](./07-durable-objects.md) |
---

---

## 改訂履歴：版数 1.1 での主な訂正（レビュー指摘への対応）

版数 1.0 には、実装すると破綻する重大な誤りが含まれていた。以下はすべて Cloudflare / SvelteKit / better-auth の一次情報で裏付けを取ったうえで訂正している。

| # | 1.0 の誤り | 1.1 での訂正 | 章 |
|---|---|---|---|
| 1 | realtime Worker が `hello` を検証してから DO へ接続を渡す（Hibernation API の標準フローと両立しない） | **DO が Upgrade を直接受理し、DO 自身が `hello` を検証**する。Worker は Origin/Upgrade/粗いレート制限のみ | 3.5 / 9.2 / 11.2 |
| 2 | 「デプロイしても進行中 DO は旧コードで完走する」 | **誤り。コード更新は全 DO を再起動し WebSocket を切断する。** 版数レジストリで旧 reducer を保持し、再接続で吸収する | 8.4 / 15.1 |
| 3 | rev が Command 単位なのに `event_log.rev` が単独主キー、かつ Event だけで再現できるとしていた | rev は Command 単位、Event は `(rev, event_seq)`。**`command_log` を再現の正本**とし Event は派生物 | 8.2 / 9.2 / 13.3 |
| 4 | 対戦ログ全体を1つの Queue メッセージで送り、10分後に無条件で DO を削除 | Queue には `matchId` のみ（**128KB上限**）。consumer が export→保存→`archive` 通知し、**`archived` 確認まで削除しない**。R2 は運営用完全版と座席別射影版を分離 | 9.2 / 13.3 |
| 5 | クライアントで同じ `applyCommand` を実行して楽観更新 | **秘匿情報がないため実行不能。** 見た目の予告専用の `predictView` に置き換え | 8.5 / 14.3 |
| 6 | CSP に `frame-src` がなく Turnstile が動かない／`style-src` を nonce のみに縛り Svelte トランジションが動かない | `frame-src https://challenges.cloudflare.com` を追加。`style-src` にのみ `unsafe-inline` を許容（`script-src` は nonce 維持） | 11.1 |
| 7 | `RL_GUEST: 3 / 3600秒`（`ratelimit` バインディングの `period` は10秒か60秒のみ） | バインディングは60秒バースト制限に限定し、**1時間の厳密な上限は専用 DO** で管理 | 11.4 / 9.1 |
| 8 | 戦闘・トリガー・手札上限などが未確定で reducer を実装できない | 召喚酔い、攻撃回数、反撃、同時死亡、トリガー解決順、ループ防止、手札上限、引き分け、ターン数の定義などを確定 | 7.1a |

加えて、`xoshiro128**` から HMAC-SHA-256 カウンタ方式の決定論 CSPRNG への変更（9.5）、D1 Time Travel の保持日数訂正（無料プランは7日。15.2）、認証・認可・入力検証のフェーズ前倒し（17章）、無料プラン制約の明文化（4.3）などを行った。