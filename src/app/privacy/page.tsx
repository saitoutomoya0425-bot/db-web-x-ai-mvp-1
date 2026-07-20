import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";

export const revalidate = 86400;
export const metadata: Metadata = {
  title: "プライバシーポリシー",
  description: "おかずDBにおける利用情報・お問い合わせ情報の取扱い。",
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
  return <LegalPage title="プライバシーポリシー" lead="おかずDBでは、サービス提供と改善に必要な範囲で情報を取り扱います。">
    <section><h2 className="text-xl font-bold text-white">取得する情報</h2><p className="mt-2">検索語、閲覧した作品、関連作品や販売案内のクリック、参照元、ブラウザ情報、匿名のセッション識別子を記録する場合があります。お問い合わせ時は、入力された名前、メールアドレス、件名、本文を取得します。</p></section>
    <section><h2 className="text-xl font-bold text-white">利用目的</h2><p className="mt-2">検索・ランキング機能の提供、サイト改善、不正利用防止、お問い合わせへの対応、障害調査のために利用します。</p></section>
    <section><h2 className="text-xl font-bold text-white">Cookie</h2><p className="mt-2">ページ間の利用状況を匿名で関連付けるため、Cookieにランダムな識別子を保存します。氏名やメールアドレスをCookieへ保存しません。</p></section>
    <section><h2 className="text-xl font-bold text-white">外部サービス</h2><p className="mt-2">サイト運用にVercelおよびSupabaseを利用しています。正規販売ページへのリンクが掲載される場合、遷移先では各事業者のプライバシーポリシーが適用されます。</p></section>
    <section><h2 className="text-xl font-bold text-white">情報の管理</h2><p className="mt-2">取得情報は目的達成に必要な期間に限り保管し、不要となった情報は適切に削除します。法令に基づく場合を除き、本人の同意なく個人情報を第三者へ販売しません。</p></section>
    <section><h2 className="text-xl font-bold text-white">お問い合わせ</h2><p className="mt-2">保有情報や本方針に関するご連絡は、お問い合わせページからお送りください。</p></section>
    <p className="text-xs text-slate-500">制定日：2026年7月4日</p>
  </LegalPage>;
}
