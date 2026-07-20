import type { Metadata } from "next";
import { Search } from "lucide-react";
import { SearchBox } from "@/components/search-box";
import { RecentlyViewedCarousel } from "@/components/recently-viewed";
import { LoadMoreWorkGrid } from "@/components/load-more-work-grid";
import { searchVideos, type SearchSort } from "@/lib/queries/public-works";
import type { WorkDetail } from "@/types/database";
import { saveSearchLog } from "@/lib/search-log";

export const metadata: Metadata = { title: "作品検索", robots: { index: false, follow: true } };

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string; sort?: string; actress?: string; maker?: string; series?: string; page?: string; view?: string }> }) {
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q.trim().slice(0, 200) : "";
  const sort: SearchSort = params.sort === "new" || params.sort === "release" ? params.sort : "popular";
  const actress = typeof params.actress === "string" ? params.actress.trim().slice(0, 100) : "";
  const maker = typeof params.maker === "string" ? params.maker.trim().slice(0, 100) : "";
  const series = typeof params.series === "string" ? params.series.trim().slice(0, 100) : "";
  const pageSize = 96;
  let works: WorkDetail[] = [];
  let searchError = false;
  try {
    if (q || actress || maker || series) await saveSearchLog({ productCode: q || actress || maker || series, source: "web_search", userAgent: null, referrer: null });
    works = q || actress || maker || series ? await searchVideos(q, pageSize, 0, sort, { actress, maker, series }) : [];
  } catch (error) {
    console.error("SearchPage failed:", error);
    searchError = true;
  }
  return (
    <main className="mx-auto max-w-6xl px-5 py-12">
      <div className="mb-8 text-center"><p className="mb-2 flex items-center justify-center gap-2 text-sm text-violet-400"><Search className="size-4" />SEARCH</p><h1 className="text-3xl font-black">作品を探す</h1><p className="mx-auto mt-3 max-w-2xl text-sm leading-7 text-slate-400">品番、女優名、メーカー名、シリーズ名、ジャンルで検索できます。品番は一部だけ・ハイフンなしでも試せます。</p></div>
      <SearchBox />
      <RecentlyViewedCarousel className="mt-10 px-0 sm:px-0" />
      {(q || actress || maker || series) && <form className="mt-6 grid gap-3 rounded-xl border border-slate-800 bg-slate-900/40 p-4 sm:grid-cols-2 lg:grid-cols-5">
        <input type="hidden" name="q" value={q} />
        <input name="actress" defaultValue={actress} placeholder="女優名" className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm" />
        <input name="maker" defaultValue={maker} placeholder="メーカー名" className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm" />
        <input name="series" defaultValue={series} placeholder="シリーズ名" className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm" />
        <label className="sr-only" htmlFor="sort">並び順</label><select id="sort" name="sort" defaultValue={sort} className="h-10 rounded-lg border border-slate-700 bg-slate-900 px-3 text-slate-100">
            <option value="popular">人気順</option>
            <option value="new">新着順</option>
            <option value="release">発売日順</option>
          </select>
        <button className="h-10 rounded-lg bg-slate-800 px-4 text-sm hover:bg-slate-700">適用</button>
      </form>}
      {searchError && <p className="mt-8 rounded-xl border border-amber-800 bg-amber-950/30 p-5 text-center text-amber-200">検索処理で一時的な問題が発生しました。時間をおいて再度お試しください。</p>}
      {(q || actress || maker || series) && <div className="mt-8 flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-slate-400">検索結果：{works.length}件</p></div>}
      {works.length > 0 ? <LoadMoreWorkGrid works={works} className="mt-5" />
        : (q || actress || maker || series) && !searchError && <div className="mt-8 rounded-2xl border border-dashed border-slate-700 bg-slate-900/35 p-8 text-center">
          <p className="text-lg font-bold text-slate-200">一致する作品が見つかりませんでした</p>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-7 text-slate-400">品番の一部、ハイフンなし表記、女優名・メーカー名・ジャンル名など、条件を少し変えてお試しください。</p>
          <div className="mt-5 flex flex-wrap justify-center gap-2 text-xs text-slate-400"><span className="rounded-full bg-white/[0.05] px-3 py-1.5">例：IPX123</span><span className="rounded-full bg-white/[0.05] px-3 py-1.5">例：メーカー名</span><span className="rounded-full bg-white/[0.05] px-3 py-1.5">例：ジャンル名</span></div>
        </div>}
    </main>
  );
}
