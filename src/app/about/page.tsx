import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";

export const revalidate = 86400;
export const metadata: Metadata = {
  title: "サイトについて",
  description: "おかずDBの目的、掲載情報、運営方針について。",
  alternates: { canonical: "/about" },
};

export default function AboutPage() {
  return <LegalPage title="サイトについて" lead="おかずDBは、成人向け作品を品番、女優名、メーカー、シリーズ、ジャンルなどから検索・閲覧できる作品情報データベースです。">
    <section><h2 className="text-xl font-bold text-white">サイトの目的</h2><p className="mt-2">作品名や品番が分かっている方が、作品情報や関連作品を整理して確認できる場所を提供します。動画ファイルの配信や販売は行いません。</p></section>
    <section><h2 className="text-xl font-bold text-white">掲載情報</h2><p className="mt-2">品番、作品名、出演者、メーカー、シリーズ、ジャンル、発売日などを掲載します。公開前に出典と利用条件を確認し、確認できない素材や情報は公開しない方針です。</p></section>
    <section><h2 className="text-xl font-bold text-white">今後の方針</h2><p className="mt-2">正規販売ページを確認できた作品について、販売元の規約に従った案内を掲載する場合があります。商業作品を中心に運用し、クリエイター作品や同人作品は将来別カテゴリとして扱う予定です。</p></section>
    <section><h2 className="text-xl font-bold text-white">年齢制限</h2><p className="mt-2">当サイトは成人向け作品情報を扱うため、18歳未満の方は利用できません。</p></section>
  </LegalPage>;
}
