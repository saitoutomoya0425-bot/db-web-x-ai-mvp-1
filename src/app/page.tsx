import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight, Bot, Clock3, Sparkles, Tags, TrendingUp, Users } from "lucide-react";
import { SearchBox } from "@/components/search-box";
import { PublicWorkCard } from "@/components/public-work-card";
import { getActressRanking, getNewestWorks, getPopularWorks } from "@/lib/queries/public-works";
import { getPopularTags, getRecommendedWorks, getTrendingWorks } from "@/lib/queries/discovery";

export const metadata: Metadata = { alternates: { canonical: "/" } };

export default async function HomePage() {
  const [popular, trending, newest, recommended, actresses, tags] = await Promise.all([getPopularWorks(8), getTrendingWorks(8), getNewestWorks(8), getRecommendedWorks(8), getActressRanking(6), getPopularTags(20)]);
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  return (
    <main>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify({ "@context": "https://schema.org", "@type": "WebSite", name: "おかずDB", url: site, potentialAction: { "@type": "SearchAction", target: `${site}/search?q={search_term_string}`, "query-input": "required name=search_term_string" } }) }} />
      <section className="bg-[radial-gradient(circle_at_top,#3b0764,#020617_55%)] px-5 py-24 text-center">
        <div className="mx-auto max-w-3xl">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-violet-800 bg-violet-950/60 px-4 py-2 text-xs text-violet-200"><Sparkles className="size-4" />品番から作品をすぐにチェック</div>
          <h1 className="text-4xl font-black tracking-tight sm:text-6xl">その品番、<br /><span className="text-violet-400">すぐ見つかる。</span></h1>
          <p className="mx-auto mb-9 mt-6 max-w-xl text-slate-400">品番を入力すると、作品情報・女優・関連作品をまとめて確認できます。</p>
          <SearchBox />
        </div>
      </section>
      <section className="mx-auto max-w-6xl px-5 pb-16">
        <div className="mb-7 flex items-end justify-between"><div><p className="mb-2 flex items-center gap-2 text-sm font-medium text-orange-400"><TrendingUp className="size-4" />RISING</p><h2 className="text-2xl font-bold">人気急上昇作品</h2></div><Link href="/ranking?period=7" className="flex items-center gap-1 text-sm text-slate-400">週間ランキング<ArrowRight className="size-4" /></Link></div>
        {trending.length > 0 && <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">{trending.map((work, index) => <PublicWorkCard key={work.id} work={work} rank={index + 1} />)}</div>}
      </section>
      <section className="mx-auto max-w-6xl px-5 pb-16">
        <div className="mb-7 flex items-end justify-between"><div><p className="mb-2 flex items-center gap-2 text-sm font-medium text-violet-400"><Clock3 className="size-4" />NEW ARRIVALS</p><h2 className="text-2xl font-bold">新着作品</h2></div><Link href="/search?q=*&sort=new" className="flex items-center gap-1 text-sm text-slate-400 hover:text-white">新着を探す<ArrowRight className="size-4" /></Link></div>
        {newest.length > 0 && <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">{newest.map((work) => <PublicWorkCard key={work.id} work={work} />)}</div>}
      </section>
      <section className="mx-auto max-w-6xl px-5 pb-16">
        <p className="mb-2 flex items-center gap-2 text-sm font-medium text-violet-400"><Bot className="size-4" />RECOMMENDED</p><h2 className="mb-7 text-2xl font-bold">おすすめ作品</h2>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">{recommended.map((work) => <PublicWorkCard key={work.id} work={work} />)}</div>
      </section>
      <section className="mx-auto max-w-6xl px-5 py-16">
        <div className="mb-7 flex items-end justify-between"><div><p className="mb-2 flex items-center gap-2 text-sm font-medium text-violet-400"><TrendingUp className="size-4" />TRENDING</p><h2 className="text-2xl font-bold">人気作品</h2></div><Link href="/ranking" className="flex items-center gap-1 text-sm text-slate-400 hover:text-white">すべて見る<ArrowRight className="size-4" /></Link></div>
        {popular.length ? <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">{popular.map((work, index) => <PublicWorkCard key={work.id} work={work} rank={index + 1} />)}</div> : <p className="rounded-xl border border-dashed border-slate-700 py-16 text-center text-slate-500">作品データを登録すると、ここに表示されます。</p>}
      </section>
      <section id="actresses" className="mx-auto max-w-6xl px-5 pb-12">
        <p className="mb-2 flex items-center gap-2 text-sm font-medium text-violet-400"><Users className="size-4" />ACTRESSES</p><h2 className="mb-7 text-2xl font-bold">人気女優から探す</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{actresses.map(({ actress, count }, index) => <Link href={`/actress/${encodeURIComponent(actress.name)}`} key={actress.id} className="flex items-center gap-4 rounded-xl border border-slate-800 bg-slate-900/40 p-4 transition hover:border-violet-700 hover:bg-slate-900"><span className="grid size-10 place-items-center rounded-full bg-violet-950 font-bold text-violet-300">{index + 1}</span><div><p className="font-medium">{actress.name}</p><p className="text-xs text-slate-500">{actress.name_kana ?? `${count} searches`}</p></div></Link>)}</div>
        <Link href="/rankings/actress" className="mt-5 inline-flex items-center gap-1 text-sm text-violet-300">女優ランキングを見る<ArrowRight className="size-4" /></Link>
      </section>
      {tags.length > 0 && <section className="mx-auto max-w-6xl px-5 pb-12"><p className="mb-3 flex items-center gap-2 text-sm text-violet-400"><Tags className="size-4" />TAGS</p><h2 className="text-2xl font-bold">タグから探す</h2><div className="mt-5 flex flex-wrap gap-2">{tags.map((tag) => <Link key={tag.id} href={`/tag/${encodeURIComponent(tag.name)}`} className="rounded-full border border-slate-700 bg-slate-900 px-4 py-2 text-sm hover:border-violet-500">#{tag.name}</Link>)}</div></section>}
    </main>
  );
}
