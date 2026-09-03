// wrangler types は wrangler.jsonc の vars/bindings しか拾わないため、
// .dev.vars / `wrangler secret` だけで管理するシークレットはここで手動拡張する
// （doc/designs/13-secrets-lifecycle.md）。import/export を持たないため、
// worker-configuration.d.ts が宣言するグローバルな `Env` へマージされる。

interface Env {
	/** WSチケット署名鍵（kid付き複数世代。現状は v1 のみ）。 */
	WS_TICKET_SECRET_V1: string;
}
