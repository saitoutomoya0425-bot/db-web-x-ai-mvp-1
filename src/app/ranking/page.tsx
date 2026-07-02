import type { Metadata } from "next";
import Link from "next/link";
import { Trophy } from "lucide-react";
import { PublicWorkCard } from "@/components/public-work-card";
import { getPopularWorksPeriod } from "@/lib/queries/public-works";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "人気作品ランキング", description: "検索回数をもとにした人気作品ランキング", alternates: { canonical: "/ranking" } };

export default async function RankingPage({ searchParams }: { searchParams: Promise<{ period?: string; page?: string }> }) {
  const params = await searchParams;
  const period = params.period === "7" || params.period === "30" ? params.period : "all";
  const page = Math.max(1, Math.min(Number(params.page) || 1, 1000));
  const pageSize = 40;
  const works = await getPopularWorksPeriod(pageSize, (page - 1) * pageSize, period === "all" ? null : Number(period));
  return (
    <main className="mx-auto max-w-6xl px-5 py-12">
      <p className="mb-2 flex items-center gap-2 text-sm font-medium text-violet-400"><Trophy className="size-4" />POPULARITY RANKING</p>
      <h1 className="text-3xl font-black">人気作品ランキング</h1>
      <p className="mt-3 text-sm text-slate-400">品番検索回数をもとに集計しています。</p>
      <nav className="mt-6 flex gap-2" aria-label="集計期間">{[["7","週間"],["30","月間"],["all","総合"]].map(([value, label]) => <Link key={value} href={`/ranking?period=${value}`} className={`rounded-full px-4 py-2 text-sm ${period === value ? "bg-violet-600 text-white" : "bg-slate-900 text-slate-300 hover:bg-slate-800"}`}>{label}</Link>)}</nav>
      {works.length ? <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{works.map((work, index) => <PublicWorkCard key={work.id} work={work} rank={(page - 1) * pageSize + index + 1} count={work.search_count} />)}</div> : <p className="mt-8 rounded-xl border border-dashed border-slate-700 py-20 text-center text-slate-500">ランキングデータはまだありません。</p>}
      <div className="mt-10 flex justify-center gap-3">{page > 1 && <Link className="rounded-lg bg-slate-800 px-5 py-3 text-sm" href={`/ranking?period=${period}&page=${page - 1}`}>前へ</Link>}{works.length === pageSize && <Link className="rounded-lg bg-violet-600 px-5 py-3 text-sm" href={`/ranking?period=${period}&page=${page + 1}`}>次へ</Link>}</div>
    </main>
  );
}
