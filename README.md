# エメラルドワニ

共通の8体を動かし、敵ワニを捕獲・護送・捕食して3点を先取する対戦ゲームです。現在はロードマップのフェーズ0〜5が完了し、CPU戦、オンライン対戦、アカウント、対戦履歴、リプレイまで通しで動きます。

## ローカル起動

Node.js 22.12以上とpnpmを使用します。

```sh
pnpm install
pnpm db:migrate:local
pnpm dev
```

- Web: `http://localhost:5173`
- Realtime Worker: `http://localhost:8787`

`.dev.vars.example`を`.dev.vars`へコピーし、ローカル専用の値を設定してください。開発サーバの起動後は、次のコマンドで各フェーズの受け入れ条件をまとめて確認できます。

```sh
pnpm verify:phase0   # Web、Realtime Worker、匿名セッションの一致
pnpm verify:phase4   # 2ゲストで matchmaking → 布陣 → 対局 → 投了
pnpm verify:phase5   # 対局 → アーカイブ → 本登録 → 戦績移行 → 履歴・リプレイ・通報
```

メールアドレスの確認とパスワード再設定は、ローカルでは配送業者を呼ばず本文（リンクを含む）を`pnpm dev`の出力へ書き出します。配送業者の設定は[メール配送](doc/email.md)を参照してください。

## 品質チェック

```sh
pnpm check
pnpm lint
pnpm test:unit -- --run
pnpm build
```

## 画面の文言

画面に出す文言は`messages/ja.json`と`messages/en.json`（Paraglide）に集約しています。UIへ文字リテラルを直接書かず、`m.<key>()`から引いてください。コード値と文言の対応は[`src/lib/i18n/match-labels.ts`](src/lib/i18n/match-labels.ts)にまとめています。

ルールエンジンが返すイベント文とワニの名前、ゲストの自動生成表示名はカタログの対象外です。これらはリプレイやD1へ永続化される版数付きのデータであり、閲覧者のlocaleで変わってはいけないためです（理由は同ファイルの注記を参照）。

ルールは[ルールブック](doc/designs/05-game-rules.md)、確定した盤面仕様は[盤面・初期化仕様](doc/board.md)、実装状況は[ロードマップ](doc/designs/21-roadmap.md)を参照してください。
