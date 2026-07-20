import type { Metadata } from "next";
import { Trophy } from "lucide-react";
import { WorkCarousel } from "@/components/work-carousel";
import { getPopularWorksPeriod } from "@/lib/queries/public-works";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "人気作品ランキング", description: "検索回数をもとにした人気作品ランキング", alternates: { canonical: "/ranking" } };

export default async function RankingPage() {
  const [weekly, monthly, overall] = await Promise.all([
    getPopularWorksPeriod(40, 0, 7),
    getPopularWorksPeriod(40, 0, 30),
    getPopularWorksPeriod(40, 0, null),
  ]);
  const hasRanking = weekly.length || monthly.length || overall.length;
  return (
    <main className="py-12">
      <header className="mx-auto max-w-7xl px-5">
        <p className="mb-2 flex items-center gap-2 text-sm font-medium text-violet-400"><Trophy className="size-4" />POPULARITY RANKING</p>
        <h1 className="text-3xl font-black">人気作品ランキング</h1>
        <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-400">品番検索回数をもとに、週間・月間・総合の人気作品を横に眺められます。</p>
      </header>
      {hasRanking ? (
        <div className="mt-10 space-y-14">
          <WorkCarousel title="週間ランキング" description="直近7日でよく探されている作品です。" works={weekly} showRank />
          <WorkCarousel title="月間ランキング" description="直近30日で検索されている作品です。" works={monthly} showRank />
          <WorkCarousel title="総合ランキング" description="これまでの検索傾向をもとにしたランキングです。" works={overall} showRank />
        </div>
      ) : <p className="mx-auto mt-8 max-w-6xl rounded-xl border border-dashed border-slate-700 py-20 text-center text-slate-500">ランキングデータはまだありません。</p>}
    </main>
  );
}
