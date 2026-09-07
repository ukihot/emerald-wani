/**
 * 公開先の確定値（doc/deploy.md）。
 *
 * 規約・ポリシー・窓口・security.txt が同じ値を指す必要があるため1か所に置く。
 * 環境変数にしないのは、環境ごとに変わる値ではないため（stg も本番と同じ窓口を案内する）。
 */
export const SITE_DOMAIN = 'emerald-wani.jocarium.productions';

/** 問い合わせ・異議申立て・個人情報・脆弱性報告のすべてを受ける単一の窓口。 */
export const CONTACT_EMAIL = 'emerald-wani@jocarium.productions';
