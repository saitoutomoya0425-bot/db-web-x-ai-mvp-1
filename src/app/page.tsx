import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight, Bot, Clock3, Factory, Flame, Sparkles, Trophy, Users } from "lucide-react";
import { SearchBox } from "@/components/search-box";
import { RecentlyViewedCarousel } from "@/components/recently-viewed";
import { WorkCarousel } from "@/components/work-carousel";
import { EntityCarousel } from "@/components/entity-carousel";
import { getPopularWorksPeriod } from "@/lib/queries/public-works";
import { getCatalogWorks } from "@/lib/queries/catalog";
import { getEntityRanking, getRecommendedWorks } from "@/lib/queries/discovery";

export const metadata: Metadata = { alternates: { canonical: "/" } };

export default async function HomePage() {
  const [newest, popular, recommended, weeklyRanking, actresses, makers] = await Promise.all([
    getCatalogWorks({ sort: "newest", limit: 30 }),
    getCatalogWorks({ sort: "popular", limit: 30 }),
    getRecommendedWorks(30),
    getPopularWorksPeriod(10, 0, 7),
    getEntityRanking("actress", "week", 10),
    getEntityRanking("maker", "week", 10),
  ]);
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const hasWorks = newest.length || popular.length || recommended.length || weeklyRanking.length;
  return (
    <main>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify({ "@context": "https://schema.org", "@type": "WebSite", name: "おかずDB", url: site, potentialAction: { "@type": "SearchAction", target: `${site}/search?q={search_term_string}`, "query-input": "required name=search_term_string" } }) }} />
      <section className="bg-[radial-gradient(circle_at_top,#3b0764,#020617_58%)] px-5 py-6 text-center sm:py-8">
        <div className="mx-auto max-w-5xl">
          <div className="mb-2.5 inline-flex items-center gap-2 rounded-full border border-violet-800 bg-violet-950/60 px-3.5 py-1.5 text-[11px] text-violet-200"><Sparkles className="size-3.5" />成人向け作品情報データベース</div>
          <h1 className="text-3xl font-black tracking-tight sm:text-5xl">作品を、<span className="text-violet-400">すぐ探せる。</span></h1>
          <p className="mx-auto mb-4 mt-2.5 max-w-2xl text-sm leading-6 text-slate-300 sm:text-base">品番・女優・メーカー・ジャンルで検索</p>
          <SearchBox />
        </div>
      </section>
      <RecentlyViewedCarousel className="py-5 sm:py-8" />
      {!hasWorks && <section className="mx-auto max-w-3xl px-5 py-14 text-center"><h2 className="text-xl font-bold">公開作品を順次追加しています</h2><p className="mt-3 text-sm leading-7 text-slate-400">正規の取得元と素材の利用条件を確認できた作品だけを掲載します。公開済み作品が追加されると、検索・作品一覧・ランキングに表示されます。</p><Link href="/about" className="mt-5 inline-flex text-sm font-bold text-violet-300">サイトの掲載方針を見る<ArrowRight className="ml-1 size-4" /></Link></section>}
      <WorkCarousel eyebrow={<span className="flex items-center gap-2"><Clock3 className="size-4" />新着</span>} title="新着作品" works={newest} action={<Link href="/works?sort=newest" className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-white">新着を探す<ArrowRight className="size-4" /></Link>} className="pb-6 sm:pb-10" />
      <WorkCarousel eyebrow={<span className="flex items-center gap-2 text-orange-300"><Flame className="size-4" />人気</span>} title="人気作品" works={popular} action={<Link href="/works?sort=popular" className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-white">人気を探す<ArrowRight className="size-4" /></Link>} className="pb-6 sm:pb-10" />
      <WorkCarousel eyebrow={<span className="flex items-center gap-2"><Bot className="size-4" />おすすめ</span>} title="おすすめ作品" works={recommended} action={<Link href="/works?sort=recommended" className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-white">おすすめを探す<ArrowRight className="size-4" /></Link>} className="pb-6 sm:pb-10" />
      <WorkCarousel eyebrow={<span className="flex items-center gap-2"><Trophy className="size-4" />週間</span>} title="今週の人気ランキング" works={weeklyRanking} showRank action={<Link href="/ranking" className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-white">ランキングをもっと見る<ArrowRight className="size-4" /></Link>} className="pb-6 sm:pb-10" />
      <EntityCarousel eyebrow={<span className="flex items-center gap-2"><Users className="size-4" />女優</span>} title="人気女優" type="actress" items={actresses} actionHref="/rankings/actress" actionLabel="女優をもっと見る" className="pb-6 sm:pb-10" />
      <EntityCarousel eyebrow={<span className="flex items-center gap-2"><Factory className="size-4" />メーカー</span>} title="人気メーカー" type="maker" items={makers} actionHref="/makers" actionLabel="メーカーをもっと見る" className="pb-6 sm:pb-10" />
    </main>
  );
}
