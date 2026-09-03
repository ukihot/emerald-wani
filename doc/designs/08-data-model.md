# データモデル（D1）

> [設計ドキュメント索引](./README.md)


### 12.1 テーブル一覧

better-auth 生成分（`user` / `session` / `account` / `verification` + `anonymous`・`admin`・`twoFactor` の追加カラム）に加えて、以下を定義する。

| テーブル | 主な列 | 用途 |
|---|---|---|
| `player_profile` | `user_id` PK, `display_name`, `icon_id`, `settings_json`, `created_at` | 表示情報とクライアント設定 |
| `card` | `id` PK(`CRD_0001`), `rule_version`, `kind`, `rarity`, `is_enabled`, `released_at` | 図鑑メタと配布・停止状態（効果は持たない） |
| `user_card` | (`user_id`,`card_id`) PK, `count`, `acquired_at` | 所有カード |
| `deck` | `id` PK(UUIDv7), `user_id`, `name`, `is_active`, `rule_version`, `created_at`, `updated_at`, `deleted_at` | デッキ |
| `deck_card` | (`deck_id`,`card_id`) PK, `count` | デッキ内容 |
| `match` | `id` PK(UUIDv7), `mode`, `rule_version`, `status`, `winner_seat`, `end_reason`, `turn_count`, `started_at`, `ended_at`, `replay_key_ops`, `replay_key_seat0`, `replay_key_seat1` | 対戦結果。`replay_key_ops` は運営用完全版、`replay_key_seat*` は座席別の射影版（13.3） |
| `match_player` | (`match_id`,`seat`) PK, `user_id`, `deck_id`, `deck_snapshot_json`, `result`, `final_hp` | 参加者と結果 |
| `match_invite` | `code` PK, `match_id`, `host_user_id`, `expires_at`, `used_at` | フレンド対戦の招待 |
| `security_event` | `id` PK(UUIDv7), `ts`, `type`, `severity`, `user_id`, `ip_hash`, `ua_hash`, `detail_json` | セキュリティ監査ログ |
| `admin_audit` | `id` PK(UUIDv7), `ts`, `admin_user_id`, `action`, `target_type`, `target_id`, `detail_json` | 運営操作履歴 |
| `announcement` | `id` PK, `title`, `body_md`, `published_at`, `expires_at` | お知らせ。`body_md` は **Markdown のみ**を許可し、生HTMLは許可リスト方式のサニタイザ（`rehype-sanitize` 等、許可タグ・属性を明示列挙）を通してから描画する。任意HTMLの直接挿入は行わない |
| `report` | `id` PK, `reporter_user_id`, `target_user_id`, `match_id`, `reason`, `status`, `created_at` | 通報 |

### 12.2 設計方針

- **対戦イベントの明細は D1 に入れない。** 1試合で数百イベント × 同時多数試合になるため、D1 の書き込み負荷とストレージが破綻する。明細は R2 のリプレイ束（13.3）に置き、D1 は `replay_key` のポインタのみを持つ。
- `deck_snapshot_json` を `match_player` に持つことで、**後からデッキを編集されても対戦時の構成が変わらない**（企画書 18「行動検証」の前提）。
- 論理削除（`deleted_at`）はデッキのみ。ユーザ削除は 15.2 の方針に従う。
- 個人情報（メールアドレス）は `user` テーブルのみに保持し、他テーブルへ複製しない。ログには `user_id` のみを出す。
- IP・User-Agent は生値を保存せず、**日次ローテートするソルトで HMAC したハッシュ** を保存する（不正検知には十分で、個人特定性を下げられる）。

### 12.3 インデックス

- `deck(user_id, deleted_at)`
- `match_player(user_id, match_id)`（履歴一覧）
- `match(ended_at)`（新着順）
- `security_event(ts)` / `security_event(user_id, ts)`
- `match_invite(expires_at)`（期限切れの掃除）

---
