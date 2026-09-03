# データモデル（D1）

> [設計ドキュメント索引](./README.md)

## 1. テーブル一覧

better-auth 生成分（`user` / `session` / `account` / `verification` と各プラグインの追加列）に加えて、以下を定義する。

| テーブル         | 主な列                                                                                                                                                                                         | 用途                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `player_profile` | `user_id` PK, `display_name`, `icon_id`, `settings_json`, `created_at`                                                                                                                         | 表示情報とクライアント設定                                              |
| `match`          | `id` PK(UUIDv7), `mode`, `rule_version`, `map_version`, `map_seed`, `status`, `winner_seat`, `end_reason`, `round_count`, `score_seat0`, `score_seat1`, `started_at`, `ended_at`, `replay_key` | 対戦結果と再現に必要な版数                                              |
| `match_player`   | (`match_id`,`seat`) PK, `user_id`, `result`                                                                                                                                                    | 参加者と結果                                                            |
| `match_invite`   | `code` PK, `match_id`, `host_user_id`, `expires_at`, `used_at`                                                                                                                                 | フレンド対戦の招待                                                      |
| `security_event` | `id` PK(UUIDv7), `ts`, `type`, `severity`, `user_id`, `ip_hash`, `ua_hash`, `detail_json`                                                                                                      | セキュリティ監査ログ                                                    |
| `admin_audit`    | `id` PK(UUIDv7), `ts`, `admin_user_id`, `action`, `target_type`, `target_id`, `detail_json`                                                                                                    | 運営操作履歴                                                            |
| `announcement`   | `id` PK, `title`, `body_md`, `published_at`, `expires_at`                                                                                                                                      | お知らせ。Markdown のみを許可し、生HTMLは許可リスト方式でサニタイズする |
| `report`         | `id` PK, `reporter_user_id`, `target_user_id`, `match_id`, `reason`, `status`, `created_at`                                                                                                    | 通報                                                                    |

カード、所有カード、デッキのテーブルは設けない。全プレイヤーがルール版数で固定された同一の8体を使用するため、対戦ごとの構成スナップショットも不要である。

## 2. 設計方針

- 対戦中の正は MatchRoom DO の内蔵 SQLite に置く。
- 対戦 Command と Event の明細は D1 に入れず、終局後に R2 のリプレイへ書き出す。
- D1 の `match` は検索・一覧表示に必要な結果と R2 キーだけを持つ。
- `rule_version`、`map_version`、`map_seed` を保持し、同じ盤面とルールで検証可能にする。
- 個人情報は better-auth の `user` テーブル以外へ複製しない。
- IP と User-Agent は生値を保存せず、日次ローテートするソルトで HMAC した値だけを保存する。

## 3. インデックス

- `match_player(user_id, match_id)`
- `match(ended_at)`
- `match(rule_version, map_version, status)`
- `security_event(ts)` / `security_event(user_id, ts)`
- `match_invite(expires_at)`
