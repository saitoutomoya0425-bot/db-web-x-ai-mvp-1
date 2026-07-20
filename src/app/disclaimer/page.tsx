import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";

export const revalidate = 86400;
export const metadata: Metadata = {
  title: "免責事項・広告掲載方針",
  description: "おかずDBの免責事項、著作権対応、広告掲載方針。",
  alternates: { canonical: "/disclaimer" },
};

export default function DisclaimerPage() {
  return <LegalPage title="免責事項・広告掲載方針" lead="掲載情報、外部リンク、著作権および広告に関する方針を説明します。">
    <section><h2 className="text-xl font-bold text-white">掲載情報</h2><p className="mt-2">正確な情報の掲載に努めますが、完全性や最新性を保証するものではありません。価格、配信状況、販売条件は正規販売ページでご確認ください。</p></section>
    <section><h2 className="text-xl font-bold text-white">外部リンク</h2><p className="mt-2">正規販売先を確認できた場合に限り外部リンクを表示します。リンク先で提供される商品・サービスについては、各提供者が責任を負います。</p></section>
    <section><h2 className="text-xl font-bold text-white">広告掲載方針</h2><p className="mt-2">当サイトは将来、アフィリエイト広告を掲載する場合があります。広告リンクを掲載する場合は、その旨が分かる表示を行い、登録した正規販売先へのリンクだけを使用します。現在、リンク未確認の作品には販売ボタンを表示しません。</p></section>
    <section><h2 className="text-xl font-bold text-white">著作権・肖像権</h2><p className="mt-2">画像・映像・商品情報は、権利者または正規提供元が利用を認めた方法に限って掲載します。権利を侵害する意図はありません。掲載内容に問題がある場合は、お問い合わせページから対象URLと権利関係をご連絡ください。確認後、速やかに対応します。</p></section>
    <section><h2 className="text-xl font-bold text-white">禁止事項</h2><p className="mt-2">違法アップロード、海賊版、児童性的虐待コンテンツその他の違法・不適切なコンテンツへの案内は行いません。</p></section>
  </LegalPage>;
}
