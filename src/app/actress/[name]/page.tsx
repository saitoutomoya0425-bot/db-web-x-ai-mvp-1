import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Building2, ChevronLeft, ChevronRight, Film, Search, UserRound, UsersRound } from "lucide-react";
import { PublicWorkCard } from "@/components/public-work-card";
import { getActressPageData, type ActressLink, type ActressSort } from "@/lib/queries/actress-page";

const PAGE_SIZE = 24;
function decodeName(value: string) {
  try { return decodeURIComponent(value).trim(); } catch { return value.trim(); }
}
export async function generateMetadata({ params }: { params: Promise<{ name: string }> }): Promise<Metadata> {
  const name = decodeName((await params).name);
  return {
    title: `${name}の出演作品・プロフィール | おかずDB`,
    description: `${name}のプロフィールと出演作品一覧。人気順・発売日順・メーカー順で作品を検索できます。`,
    alternates: { canonical: `/actress/${encodeURIComponent(name)}` },
    openGraph: { title: `${name}の出演作品`, description: `${name}のプロフィール、出演作品、関連女優を掲載。`, type: "profile" },
  };
}

function ActressLinks({ title, icon: Icon, actresses }: { title: string; icon: typeof UsersRound; actresses: ActressLink[] }) {
  if (!actresses.length) return null;
  return <section className="mt-12"><h2 className="mb-5 flex items-center gap-2 text-xl font-bold"><Icon className="size-5 text-violet-400" />{title}</h2><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{actresses.map((actress) => <Link key={actress.name} href={`/actress/${encodeURIComponent(actress.name)}`} className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/50 p-4 transition hover:border-violet-700"><span className="grid size-11 shrink-0 place-items-center rounded-full bg-violet-950 text-violet-300"><UserRound className="size-5" /></span><span className="min-w-0"><strong className="block truncate">{actress.name}</strong><span className="text-xs text-slate-500">{actress.workCount.toLocaleString()}作品</span></span></Link>)}</div></section>;
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
  const page = Math.max(1, Math.min(Number(input.page) || 1, 100_000));
  const data = await getActressPageData(name, { query, sort, page, pageSize: PAGE_SIZE });
  if (!data.workCount && !query) notFound();
  const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  const safePage = Math.min(page, pages);
  const baseParams = new URLSearchParams();
  if (query) baseParams.set("q", query);
  if (sort !== "popular") baseParams.set("sort", sort);
  const pageUrl = (nextPage: number) => {
    const values = new URLSearchParams(baseParams);
    if (nextPage > 1) values.set("page", String(nextPage));
    const suffix = values.toString();
    return `/actress/${encodeURIComponent(name)}${suffix ? `?${suffix}` : ""}`;
  };
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
      <header className="mt-6 flex flex-col gap-6 rounded-2xl border border-slate-800 bg-gradient-to-br from-violet-950/50 to-slate-900 p-5 sm:flex-row sm:items-center sm:p-8">
        <div className="relative grid size-28 shrink-0 place-items-center overflow-hidden rounded-full border-4 border-slate-800 bg-slate-900 sm:size-36">
          {data.profileUrl ? <Image src={data.profileUrl} alt={name} fill unoptimized sizes="144px" className="object-cover" /> : <UserRound className="size-14 text-slate-600" />}
        </div>
        <div className="min-w-0"><p className="text-sm font-medium text-violet-400">ACTRESS PROFILE</p><h1 className="mt-2 break-words text-3xl font-black sm:text-4xl">{name}</h1><div className="mt-5 flex flex-wrap gap-3"><span className="inline-flex items-center gap-2 rounded-full bg-slate-950/70 px-4 py-2 text-sm"><Film className="size-4 text-violet-400" />{data.workCount.toLocaleString()}作品</span><span className="inline-flex items-center gap-2 rounded-full bg-slate-950/70 px-4 py-2 text-sm"><Building2 className="size-4 text-violet-400" />{data.makerCount.toLocaleString()}メーカー</span></div></div>
      </header>

      <section className="mt-10"><div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between"><div><h2 className="text-2xl font-bold">出演作品</h2><p className="mt-1 text-sm text-slate-500">{data.total.toLocaleString()}件中 {data.total ? (safePage - 1) * PAGE_SIZE + 1 : 0}〜{Math.min(safePage * PAGE_SIZE, data.total)}件</p></div></div>
        <form className="grid gap-3 rounded-xl border border-slate-800 bg-slate-900/50 p-4 sm:grid-cols-[1fr_auto_auto]">
          <label className="relative"><Search className="absolute left-3 top-3 size-4 text-slate-500" /><input name="q" defaultValue={query} placeholder="品番・タイトル・メーカー・シリーズで絞り込み" className="h-10 w-full rounded-lg border border-slate-700 bg-slate-950 pl-10 pr-3 text-sm outline-none focus:border-violet-500" /></label>
          <select name="sort" defaultValue={sort} aria-label="並び順" className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm"><option value="popular">人気順</option><option value="release">発売日順</option><option value="maker">メーカー順</option></select>
          <button className="h-10 rounded-lg bg-violet-600 px-5 text-sm font-bold hover:bg-violet-500">検索</button>
        </form>
        {data.works.length ? <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{data.works.map((work) => <PublicWorkCard key={work.id} work={work} />)}</div> : <div className="mt-6 rounded-xl border border-dashed border-slate-700 py-16 text-center text-slate-500">条件に一致する作品はありません。</div>}
        {pages > 1 && <nav aria-label="ページネーション" className="mt-8 flex items-center justify-center gap-3"><Link aria-disabled={safePage <= 1} href={safePage > 1 ? pageUrl(safePage - 1) : pageUrl(1)} className={`inline-flex min-h-11 items-center gap-1 rounded-lg border border-slate-700 px-4 text-sm ${safePage <= 1 ? "pointer-events-none opacity-40" : "hover:bg-slate-800"}`}><ChevronLeft className="size-4" />前へ</Link><span className="px-2 text-sm text-slate-400">{safePage.toLocaleString()} / {pages.toLocaleString()}</span><Link aria-disabled={safePage >= pages} href={safePage < pages ? pageUrl(safePage + 1) : pageUrl(pages)} className={`inline-flex min-h-11 items-center gap-1 rounded-lg border border-slate-700 px-4 text-sm ${safePage >= pages ? "pointer-events-none opacity-40" : "hover:bg-slate-800"}`}>次へ<ChevronRight className="size-4" /></Link></nav>}
      </section>
      <ActressLinks title="同じメーカーの人気女優" icon={Building2} actresses={data.sameMakerActresses} />
      <ActressLinks title="関連女優" icon={UsersRound} actresses={data.relatedActresses} />
    </main>
  );
}
