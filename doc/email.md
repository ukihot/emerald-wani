# メール配送

> [設計ドキュメント索引](./designs/README.md) / [認証・認可設計](./designs/10-auth-and-access.md)

better-auth はメール送信機能そのものを持たない。確認メールとパスワード再設定メールの
実配送はアプリ側で用意する（[認証・認可設計](./designs/10-auth-and-access.md)
「メール配送の運用」）。本書はその選定と運用を定める。

## 1. 配送業者

MVP は **Resend** を使う。

| 選定基準                     | 判断                                                           |
| ---------------------------- | -------------------------------------------------------------- |
| Workers から呼べること       | HTTP API（`POST https://api.resend.com/emails`）のみで完結する |
| SPF / DKIM / DMARC の設定    | 送信ドメインの検証手順が用意されている                         |
| 無料枠                       | MVP の想定送信量（登録・再設定のみ）に収まる                   |
| 送信内容が資格情報を含むこと | 応答本文をログに出さない運用ができる                           |

**Cloudflare Email Workers は採用しない。** あれは受信（Email Routing）の仕組みであり、
任意の宛先への送信には使えない。

実装は [`src/lib/server/email.ts`](../src/lib/server/email.ts)。呼び出しは
[`src/lib/server/auth.ts`](../src/lib/server/auth.ts) の `sendVerificationEmail` と
`sendResetPassword` の2箇所だけである。

## 2. 設定

| 名前             | 種別         | 置き場所                            | 値                                       |
| ---------------- | ------------ | ----------------------------------- | ---------------------------------------- |
| `RESEND_API_KEY` | シークレット | `.dev.vars` / `wrangler secret put` | Resend の API キー（S-04）               |
| `EMAIL_FROM`     | 公開設定     | `wrangler.jsonc` の `vars`          | `エメラルドワニ <no-reply@…>`            |
| `ENVIRONMENT`    | 公開設定     | `wrangler.jsonc` の `vars`          | `development` / `staging` / `production` |

ローテーション手順は[シークレットのライフサイクル](./designs/13-secrets-lifecycle.md)に
S-04 として従う。

**ローカル開発では鍵を設定しなくてよい。** `RESEND_API_KEY` か `EMAIL_FROM` が未設定で
`ENVIRONMENT=development` のとき、`sendEmail` は配送業者を呼ばずに本文を標準出力へ出し
`{ status: 'logged' }` を返す。ログに出るリンクをそのまま開けば、確認・再設定の導線を
最後まで確認できる。`ENVIRONMENT` が `development` 以外のときは、このフォールバックを
禁止して `{ status: 'failed' }` を返す（本番で「送ったつもり」を作らない）。

## 3. 送信ドメイン

本番・ステージングの送信ドメインに次を設定する。設定前に本番の鍵を投入しない。

- **SPF**: Resend の送信ホストを `include` した TXT レコード
- **DKIM**: Resend が発行する公開鍵の CNAME / TXT レコード
- **DMARC**: `v=DMARC1; p=quarantine; rua=…`（運用が安定したら `p=reject` へ）
- 送信元は `no-reply@` とし、返信は受け取らない（問い合わせ窓口は別途
  [脆弱性開示](./designs/20-vuln-disclosure.md) と規約に記載する）

## 4. トークンの寿命

| 種類             | 有効期限 | 使用回数 | 実装                                           |
| ---------------- | -------- | -------- | ---------------------------------------------- |
| メール確認       | 1時間    | 1回      | `emailVerification.expiresIn`                  |
| パスワード再設定 | 15分     | 1回      | `emailAndPassword.resetPasswordTokenExpiresIn` |

再設定はトークンを消費したうえで、当該ユーザーの他セッションを失効させる
（[認証・認可設計](./designs/10-auth-and-access.md) 10.2）。

## 5. 未達時の導線とレート制限

- 確認メールが届かない場合は、ホーム画面の未確認バナーから再送する（フェーズ6で
  再送ボタンとレート制限 `RL_EMAIL_SEND` を追加する。
  [セキュリティ実装対策](./designs/11-security-controls.md) 11.4）。
- パスワード再設定は、登録の有無にかかわらず同じ応答を返す（アカウント列挙の防止）。
- **現状の制限**: 送信回数のレート制限はまだ入っていない。フェーズ6の作業項目である。

## 6. ログに出さないもの

[API とプロトコル](./designs/09-api-protocol.md) 4節のとおり、メールアドレス、
トークン、Cookie をログへ出さない。配送失敗時に記録するのは **HTTP 状態コードだけ**とする
（Resend の応答本文は宛先アドレスを含むことがある）。この規律は
`src/lib/server/email.spec.ts` の単体テストで固定している。

## 7. 配送失敗の検知

- `sendEmail` が `failed` を返した場合は `console.error` に状態コードだけを残す。
  Workers Observability のログ検索で `email delivery failed` を追う
  （[監視](./designs/14-observability.md)）。
- 恒常的な失敗（DKIM 失効、鍵失効、送信上限）はアラート対象とする。アラートの
  しきい値と通知先はフェーズ6の監視設定でまとめて定める。
