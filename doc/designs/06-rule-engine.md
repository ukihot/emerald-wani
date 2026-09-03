# ルールエンジン設計

> [設計ドキュメント索引](./README.md) / [ルールブック](./05-game-rules.md)

## 1. 責務と基本形

ルールエンジンは、盤面生成、布陣、行動の合法性、状態遷移、勝敗判定を担う純粋 TypeScript モジュールとする。Cloudflare、永続化、通信、表示は扱わない。

```ts
export function applyCommand(
	state: MatchState,
	command: Command,
	ctx: EngineContext
): Result<{ state: MatchState; events: GameEvent[] }, RuleError>;
```

- 入力状態を破壊せず、新しい状態を返す。
- `Date.now()`、`Math.random()`、`crypto` を直接呼ばない。
- 時刻と、試合開始前の盤面生成に必要な乱数は `ctx` から注入する。
- 対局中のルール解決では乱数を使わない。
- 例外を通常の判定に使わず、安定したエラーコードを返す。
- 1 Command を受理するごとに `rev` を1増やし、Event は `(rev, eventSeq)` で順序づける。

## 2. 状態モデル

`MatchState` は少なくとも次を保持する。

| 領域     | 主な内容                                                                 |
| -------- | ------------------------------------------------------------------------ |
| 識別     | `matchId`, `ruleVersion`, `mapVersion`, `seed`                           |
| フェーズ | `setup`, `deployment`, `playing`, `finished`                             |
| 盤面     | 存在するマス、ゾーン、地形、巣、隣接関係                                 |
| ワニ     | 個体ID、種類、所有者、座標、捕虜、除外状態、そのターンの移動・運搬フラグ |
| 布陣     | 座席ごとの非公開配置、確定状態、締切                                     |
| 手番     | 先手、現在手番、ラウンド、残り活力、締切、連続時間切れ数                 |
| 勝敗     | 得点、結果、終了理由                                                     |
| 反復     | 同一局面判定用の正規化局面キーと出現回数                                 |
| 同期     | `rev` と処理済み `actionId`                                              |

捕虜は独立した盤面駒として占有判定せず、運搬役の `captiveId` として表現する。1体が保持できる捕虜は0または1体に限定する。

## 3. 盤面生成

```ts
export function generateBoard(seed: string, mapVersion: string): Board;
export function validateBoard(board: Board): BoardValidationResult;
```

`generateBoard` は同じ `seed` と `mapVersion` に対して常に同じ盤面を返す。生成結果は `validateBoard` でルールブックの全生成条件を検証し、不成立なら決定論的に次候補へ進む。盤面生成後は盤面そのものを保存し、リプレイ時には seed からの再生成結果とも照合する。

生成された盤面、seed、ルール版数、マップ版数、先手は布陣開始前に両者へ公開する。乱数の用途は盤面生成に限定し、対局中のランダム効果、シャッフル、ドローは存在しない。`rules-1.0.0`では南側のSeat 0を先手とする。詳細は[盤面・初期化仕様](../board.md)を正本とする。

## 4. Command

| Command                 | 送信元     | 主なパラメータ                          |
| ----------------------- | ---------- | --------------------------------------- |
| `submitDeployment`      | プレイヤー | `placements: { crocodileId, cellId }[]` |
| `move`                  | プレイヤー | `crocodileId`, `toCellId`               |
| `bite`                  | プレイヤー | `crocodileId`, `targetId`               |
| `jump`                  | プレイヤー | `crocodileId`, `toCellId`               |
| `swampWarp`             | プレイヤー | `crocodileId`, `toCellId`               |
| `transport`             | プレイヤー | `carrierId`, `toCellId`                 |
| `feed`                  | プレイヤー | `carrierId`                             |
| `endTurn`               | プレイヤー | なし                                    |
| `concede`               | プレイヤー | なし                                    |
| `sys.startMatch`        | サーバ     | `seed`, `mapVersion`                    |
| `sys.deploymentTimeout` | サーバ     | `seat`                                  |
| `sys.turnTimeout`       | サーバ     | `seat`                                  |

すべてのプレイヤー Command は `actionId`、`baseRev`、座席情報をエンベロープに持つ。サーバはフェーズ、手番、所有権、活力、移動規則、地形、占有、捕虜状態を再検証する。

## 5. Event

主な Event は次のとおり。

`boardGenerated` / `deploymentSubmitted` / `deploymentsRevealed` / `turnStarted` / `crocodileMoved` / `crocodileJumped` / `crocodileWarped` / `crocodileCaptured` / `captiveRescued` / `captiveTransported` / `captiveFed` / `scoreChanged` / `vitalityChanged` / `turnEnded` / `matchFinished`

イベントは表示と監査のための派生物であり、リプレイ再現の正本は初期条件と Command 列とする。

## 6. 可視性

布陣中だけは相手の配置が秘匿情報になる。DO は完全状態を保持し、送信直前に座席別のビューへ射影する。

```ts
export function project(state: MatchState, seat: Seat): MatchView;
export function projectEvent(event: GameEvent, seat: Seat): GameEvent | null;
```

- 盤面生成後の地形は両者に公開する。
- 布陣確定前は、相手の配置内容を送らず、確定済みかどうかだけを送る。
- 両者の布陣確定または時間切れ処理後、配置を同時公開する。
- 公開後は地形、全ワニの位置・状態、捕虜、活力、得点、手番を両者に公開する。
- 終局後のリプレイも完全情報として扱えるが、布陣の同時公開順序は再現する。

## 7. 行動解決の原則

1. Command の形式、`actionId`、`baseRev`、送信座席を検証する。
2. フェーズと手番を検証する。
3. 対象ワニの所有権と状態を検証する。
4. ワニ固有の移動・噛みつき規則、地形、占有を検証する。
5. ポチャワニ、運搬役、セッカチワニなどのターン内フラグを検証する。
6. 必要活力を検証し、原子的に状態遷移する。
7. 捕獲または救出を解決する。
8. 得点、3P勝利、30ラウンド上限、同一局面3回を判定する。
9. Event を発行し、`rev` を更新する。

一つの Command が失敗した場合、活力を含む状態は一切変更しない。

## 8. タイマー

- 布陣は45秒。時間切れ時は最後の有効配置を使い、未配置分を決定論的に自動配置する。
- 通常ターンは30秒。時間切れ時は残り活力を0にしてターンを終了する。
- 時間内に自発的な `endTurn` が成立した時点で、そのプレイヤーの連続時間切れ数をリセットする。タイムアウトが3回連続した時点で敗北とする。
- alarm の重複実行に備え、対象フェーズ・座席・deadline・rev を照合して冪等に処理する。

## 9. ルール版数とマップ版数

- `RULE_VERSION` は駒・行動・勝敗などルール全体を固定する。
- `MAP_VERSION` は固定ゾーン形状と生成アルゴリズムを固定する。
- 試合開始時の両版数を永続化し、進行中の試合とリプレイはその版数で解決する。
- 現行版は `src/lib/game/versions.ts` の `VERSION_REGISTRY` に登録する。
- 旧版を追加するときは、同レジストリから版数別 reducer / 生成器へ振り分ける。
- 版数を削除できるのは、その版数の進行中試合がなく、リプレイ検証の保持期間を過ぎた後だけとする。

## 10. クライアント予告

クライアントは `MatchView` だけで合法手候補の強調や移動アニメーションを予告できる。ただし、正の判定は常にサーバの `applyCommand` が行う。

```ts
export function predictView(
	view: MatchView,
	command: Command
): { view: MatchView; hints: AnimationHint[] } | null;
```

サーバ Event を受け取ったら予告状態を破棄し、確定状態へ置き換える。
