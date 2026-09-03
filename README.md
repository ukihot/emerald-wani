# エメラルドワニ

共通の8体を動かし、敵ワニを捕獲・護送・捕食して3点を先取する対戦ゲームです。現在はロードマップのフェーズ0〜3が完了し、ブラウザでCPU戦を遊べます。

## ローカル起動

Node.js 22.12以上とpnpmを使用します。

```sh
pnpm install
pnpm db:migrate:local
pnpm dev
```

- Web: `http://localhost:5173`
- Realtime Worker: `http://localhost:8787`

`.dev.vars.example`を`.dev.vars`へコピーし、ローカル専用の値を設定してください。開発サーバの起動後は、次のコマンドでWeb、Realtime Worker、匿名セッションをまとめて確認できます。

```sh
pnpm verify:phase0
```

## 品質チェック

```sh
pnpm check
pnpm lint
pnpm test:unit -- --run
pnpm build
```

ルールは[ルールブック](doc/designs/05-game-rules.md)、確定した盤面仕様は[盤面・初期化仕様](doc/board.md)、実装状況は[ロードマップ](doc/designs/21-roadmap.md)を参照してください。
