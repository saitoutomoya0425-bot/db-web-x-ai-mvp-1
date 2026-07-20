import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Building2, Film, Search, UserRound, UsersRound } from "lucide-react";
import { RecentlyViewedCarousel } from "@/components/recently-viewed";
import { LoadMoreWorkGrid } from "@/components/load-more-work-grid";
import { getActressPageData, type ActressLink, type ActressSort } from "@/lib/queries/actress-page";

function decodeName(value: string) {
  try { return decodeURIComponent(value).trim(); } catch { return value.trim(); }
}
export async function generateMetadata({ params }: { params: Promise<{ name: string }> }): Promise<Metadata> {
  const name = decodeName((await params).name);
  return {
    title: `${name}の出演作品・プロフィール`,
    description: `${name}のプロフィールと出演作品一覧。人気順・発売日順・メーカー順で作品を検索できます。`,
    alternates: { canonical: `/actress/${encodeURIComponent(name)}` },
    openGraph: { title: `${name}の出演作品`, description: `${name}のプロフィール、出演作品、関連女優を掲載。`, type: "profile" },
  };
}

function ActressLinks({ title, icon: Icon, actresses }: { title: string; icon: typeof UsersRound; actresses: ActressLink[] }) {
  if (!actresses.length) return null;
  return <section className="mt-12"><h2 className="mb-5 flex items-center gap-2 text-xl font-bold"><Icon className="size-5 text-violet-400" />{title}</h2><div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">{actresses.map((actress) => <Link key={actress.name} href={`/actress/${encodeURIComponent(actress.name)}`} className="flex items-center gap-3 rounded-2xl border border-white/5 bg-white/[0.035] p-3.5 transition hover:border-violet-400/30 hover:bg-white/[0.06] active:scale-[0.985]"><span className="grid size-10 shrink-0 place-items-center rounded-full bg-violet-500/15 text-violet-200"><UserRound className="size-5" /></span><span className="min-w-0"><strong className="block truncate">{actress.name}</strong><span className="text-xs text-slate-500">{actress.workCount.toLocaleString()}作品</span></span></Link>)}</div></section>;
}

export default async function ActressPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ q?: string; sort?: string; page?: string }>;
}) {
  const name = decodeName((await params).name);
  if (!name) notFound();
  const input = await searchParams;
  const query = typeof input.q === "string" ? input.q.trim().slice(0, 100) : "";
  const sort: ActressSort = input.sort === "release" || input.sort === "maker" ? input.sort : "popular";
  const data = await getActressPageData(name, { query, sort, page: 1, pageSize: 96 });
  if (!data.workCount && !query) notFound();
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const structuredData = {
    "@context": "https://schema.org", "@type": "Person", name,
    image: data.profileUrl || undefined,
    url: `${site}/actress/${encodeURIComponent(name)}`,
    mainEntityOfPage: `${site}/actress/${encodeURIComponent(name)}`,
    subjectOf: data.works.slice(0, 10).map((work) => ({ "@type": "Movie", name: work.title, identifier: work.product_code })),
  };

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-12">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData).replace(/</g, "\\u003c") }} />
      <Link href="/" className="text-sm text-slate-400 hover:text-white">← トップへ戻る</Link>
      <header className="mt-6 flex flex-col gap-6 rounded-[28px] border border-white/10 bg-gradient-to-br from-violet-950/45 to-slate-900 p-5 shadow-sm shadow-black/10 sm:flex-row sm:items-center sm:p-8">
        <div className="relative grid size-28 shrink-0 place-items-center overflow-hidden rounded-full border-4 border-slate-800 bg-slate-900 sm:size-36">
          {data.profileUrl ? <Image src={data.profileUrl} alt={name} fill unoptimized sizes="144px" className="object-cover" /> : <UserRound className="size-14 text-slate-600" />}
        </div>
        <div className="min-w-0"><p className="text-sm font-medium text-violet-400">ACTRESS PROFILE</p><h1 className="mt-2 break-words text-3xl font-black sm:text-4xl">{name}</h1><p className="mt-3 text-sm leading-7 text-slate-400">出演作品を人気順・発売日順・メーカー順で探せます。</p><div className="mt-5 flex flex-wrap gap-3"><span className="inline-flex items-center gap-2 rounded-full bg-slate-950/70 px-4 py-2 text-sm"><Film className="size-4 text-violet-400" />出演作品 {data.workCount.toLocaleString()}件</span><span className="inline-flex items-center gap-2 rounded-full bg-slate-950/70 px-4 py-2 text-sm"><Building2 className="size-4 text-violet-400" />メーカー {data.makerCount.toLocaleString()}件</span></div></div>
      </header>

      <section className="mt-10"><div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between"><div><h2 className="text-2xl font-bold">出演作品</h2><p className="mt-1 text-sm text-slate-500">{data.total.toLocaleString()}件中 最大{data.works.length.toLocaleString()}件を表示</p></div></div>
        <form className="grid gap-3 rounded-2xl border border-white/10 bg-white/[0.035] p-3 sm:grid-cols-[1fr_auto_auto] sm:p-4">
          <label className="relative"><Search className="absolute left-3 top-3 size-4 text-slate-500" /><input name="q" defaultValue={query} placeholder="品番・タイトル・メーカー・シリーズで絞り込み" className="h-10 w-full rounded-lg border border-slate-700 bg-slate-950 pl-10 pr-3 text-sm outline-none focus:border-violet-500" /></label>
          <select name="sort" defaultValue={sort} aria-label="並び順" className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm"><option value="popular">人気順</option><option value="release">発売日順</option><option value="maker">メーカー順</option></select>
          <button className="h-10 rounded-lg bg-violet-600 px-5 text-sm font-bold hover:bg-violet-500">検索</button>
        </form>
        <LoadMoreWorkGrid works={data.works} className="mt-5" emptyMessage="条件に一致する作品はありません。" />
      </section>
      <ActressLinks title="同じメーカーの人気女優" icon={Building2} actresses={data.sameMakerActresses} />
      <ActressLinks title="関連女優" icon={UsersRound} actresses={data.relatedActresses} />
      <RecentlyViewedCarousel className="mt-12 px-0 sm:px-0" />
    </main>
  );
}
