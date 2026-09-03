# ルールエンジン設計

> [設計ドキュメント索引](./README.md)


### 8.1 基本形

状態遷移は **1つの純粋関数**に集約する。

```ts
// src/lib/game/reducer.ts
export function applyCommand(
  state: MatchState,       // 完全な対戦状態（秘匿情報を含む）
  command: Command,        // 検証済みのプレイヤー行動 or システム行動
  ctx: EngineContext       // { rng: Rng, now: number, ruleVersion: string }
): Result<{ state: MatchState; events: GameEvent[] }, RuleError>;
```

- 入力状態を破壊せず、新しい状態を返す。
- `Date.now()` / `Math.random()` / `crypto` を **直接呼ばない**。すべて `ctx` 経由。
- 例外を投げず、`RuleError` を値として返す（エラーコードがそのまま WS のエラーコードになる）。

### 8.2 Command と Event

**Command**（クライアント起点＋システム起点）

| Command | 送信元 | 主なパラメータ |
|---|---|---|
| `mulligan` | プレイヤー | `keep: cardInstanceId[]` |
| `playCard` | プレイヤー | `cardInstanceId`, `lane?`, `targets?` |
| `attack` | プレイヤー | `attackerId`, `target: { kind: 'unit' \| 'leader', id? }` |
| `endTurn` | プレイヤー | — |
| `concede` | プレイヤー | — |
| `sys.startMatch` | サーバ | `seed`, `decks` |
| `sys.turnTimeout` | サーバ（alarm） | `seat` |
| `sys.disconnectLoss` | サーバ（alarm） | `seat` |

**Event**（状態差分。クライアントへの配信単位でありリプレイの記録単位）

`cardDrawn` / `cardPlayed` / `unitSummoned` / `unitAttacked` / `damageDealt` / `unitDestroyed` / `statChanged` / `environmentApplied` / `territoryChanged` / `resourceChanged` / `turnStarted` / `turnEnded` / `matchFinished` など。

イベントは「誰に見せてよいか」の可視性情報を持つ。例えば `cardDrawn` は引いた本人には `cardId` 付き、相手には枚数のみを配信する（8.3）。

**rev とイベントの対応関係（D-26）**: 1回の `applyCommand` 呼び出しは **1つの Command を受理して rev を1増加**させ、その結果として **0件以上の Event** を返す（例えば `attack` が命中・破壊・トリガ誘発の3イベントを生むことは普通にある）。したがって

- **rev は Command 単位**（Event 単位ではない）。
- Event の一意性は `(rev, eventSeq)` の複合キーで表す。`eventSeq` は同一 rev 内での発生順（0始まり）。
- クライアントへ配信する `events` フレームは `{ fromRev, toRev, batches: [{ rev, actorSeat, events: GameEvent[] }] }` の形で、rev ごとにイベントをグルーピングする（9.2 のテーブル定義、13.2 のプロトコルと対応）。

### 8.3 秘匿情報の射影

DO は完全状態を保持し、送信直前に **座席ごとのビュー** へ射影する。

```ts
// src/lib/game/view.ts
export function project(state: MatchState, seat: Seat): MatchView;
export function projectEvent(event: GameEvent, seat: Seat): GameEvent | null;
```

- 自分の手札：全内容
- 相手の手札：**枚数のみ**（カードIDは含めない）
- 両者のデッキ：**残枚数のみ**。並び順・シード・次のカードは決して含めない（企画書 18.4）
- 墓地：両者とも公開

このテストは自動化する（16.2）。「射影後のオブジェクトに相手のカードIDが含まれていないこと」をプロパティテストで検証する。

### 8.4 カードマスタの持ち方とルール版数の互換性（D-16 / D-25）

カードデータと効果ハンドラは **`src/lib/game/cards/` にコードとして同梱**し、`RULE_VERSION`（例 `"2026.09.0"`）でバージョン管理する。

**訂正: 「デプロイしても進行中DOは旧コードで完走する」は誤りだった。** Cloudflare は明確に「コード更新はすべての DO を再起動し、既存の WebSocket 接続を切断する」と定めている（[Durable Objects — WebSocket](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)）。したがって「進行中の試合が起動時のコードのまま動き続ける」という前提は成立しない。以下のとおり設計を改める。

**版数レジストリ方式**

- `src/lib/game/engines/registry.ts` が `RULE_VERSION 文字列 -> reducer実装` のマップを保持する。新しいルールを追加するときは、**既存の版数の実装をコードから削除せず**、新しい版数のディレクトリ（`engines/v2026-09-0/` 等）を追加する。
- `MatchRoom` は `match_state.rule_version` に保存された版数で `registry.resolve(ruleVersion)` を呼び、その試合専用の reducer を得る。デプロイで DO が再起動しても、再起動後の新しいコードの中に **旧版数の reducer がそのまま存在する**ため、進行中の試合は同じルールで継続できる。
- 版数は WS プロトコルのバージョンとは独立させ、`hello` の `rv` フィールドで **クライアントが対応できる最小/最大版数**をサーバへ伝える。サーバの試合版数がクライアントの対応範囲外なら `E_RULE_VERSION_UNSUPPORTED` を返し、クライアントに更新を促す。
- **廃止の時期**: ある `RULE_VERSION` を実装から削除できるのは、その版数で開始された試合が1件も進行中でなく、かつリプレイ検証（9.5・13.3）に必要な期間（リプレイ保持期間90日）を経過した後とする。運営ダッシュボードに「版数ごとの進行中試合数」を表示し、削除可否を機械的に判定できるようにする。
- **デプロイと再接続の関係**: DO 再起動により進行中の WS 接続は切断されるため、デプロイ直後は該当試合の全参加者が同時に切断を経験する。クライアントの自動再接続（15.1）がこれを吸収する。デプロイは可能な限り試合の少ない時間帯に行い、再接続の集中を許容できる設計とする（16.3 の負荷試験対象に追加）。
- D1 の `card` テーブルは「図鑑表示用のメタ」「配布状態」「利用停止フラグ」だけを持ち、**効果ロジックは持たない**。運営が `is_enabled = 0` にしたカードは、デッキ保存時とマッチ開始時に弾く。
- カード追加はコードのデプロイで行う（企画書 24「カードマスタ管理」の運営操作は、有効／無効の切り替えと図鑑メタの編集に限定）。

### 8.5 クライアントの楽観更新は `predictView` に限定する（D-28）

**訂正: 「クライアントにも `applyCommand` を同梱して同じ reducer で楽観更新する」という当初案は成立しない。** `applyCommand` は秘匿情報を含む完全な `MatchState`（相手の手札の中身、デッキの並び順、シード）を要求するが、クライアントが保持できるのは射影済みの `MatchView`（8.3）だけである。したがって同一の reducer をクライアントで動かすことはできない。

代わりに、秘匿情報を必要としない軽量な予告関数を別実装として持つ。

```ts
// src/lib/game/predict.ts
export function predictView(
  view: MatchView,     // 自分の座席から見える射影済みビュー
  command: Command      // これから送信しようとしている Command
): { view: MatchView; hints: AnimationHint[] } | null;
```

- `predictView` は **手札からカードが消える／場に仮置きされる／攻撃対象へ向かうアニメーションを開始する**、といった「見た目の予告」だけを行う。ダメージ計算・コスト検証・効果解決など、ゲームルールの正しさに関わる判断は一切行わない。
- サーバから `events` が届いたら、`predictView` による見た目の変更は**必ず**破棄し、サーバ状態で置き換える。見た目の乖離が大きい場合（例: 実際には無効だった）は、直前の予告アニメーションを打ち消すクロスフェードで補正する。
- 差異が生じた場合は `clientDesync` を計測用イベントとしてサーバへ送る（企画書 32.2「対戦状態の不整合件数」）。ここでの「差異」は `predictView` の予告とサーバ結果の見た目上のズレを指し、8.1 の `applyCommand` の再現性検証（9.5・13.3）とは別軸の計測である。

---
