import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { getEntityRanking, type RankingType } from "@/lib/queries/discovery";

const labels: Record<RankingType, string> = { actress: "女優", maker: "メーカー", series: "シリーズ" };
function isType(value: string): value is RankingType { return value in labels; }
export async function generateMetadata({ params }: { params: Promise<{ type: string }> }): Promise<Metadata> {
  const type = (await params).type;
  if (!isType(type)) return {};
  return { title: `${labels[type]}人気ランキング`, description: `検索・クリック・作品人気から集計した${labels[type]}ランキング。`, alternates: { canonical: `/rankings/${type}` } };
}
export default async function EntityRankingPage({ params, searchParams }: { params: Promise<{ type: string }>; searchParams: Promise<{ period?: string }> }) {
  const type = (await params).type;
  if (!isType(type)) notFound();
  const requested = (await searchParams).period;
  const period = requested === "day" || requested === "month" || requested === "all" ? requested : "week";
  const ranks = await getEntityRanking(type, period);
  const route = type === "actress" ? "actress" : type === "maker" ? "maker" : "series";
  return <main className="mx-auto max-w-4xl px-5 py-12"><Breadcrumbs items={[{ name: "トップ", href: "/" }, { name: "ランキング", href: "/rankings" }, { name: `${labels[type]}ランキング` }]} /><h1 className="mt-6 text-3xl font-black">{labels[type]}人気ランキング</h1><nav className="mt-6 flex gap-2">{[["day","24時間"],["week","週間"],["month","月間"],["all","総合"]].map(([key,label]) => <Link key={key} href={`?period=${key}`} className={`rounded-full px-4 py-2 text-sm ${period === key ? "bg-violet-600" : "bg-slate-900"}`}>{label}</Link>)}</nav><div className="mt-8 space-y-3">{ranks.length ? ranks.map((item) => <Link key={item.key} href={`/${route}/${encodeURIComponent(item.key)}`} className="grid grid-cols-[48px_1fr_auto] items-center gap-4 rounded-xl border border-slate-800 bg-slate-900/40 p-4 hover:border-violet-700"><span className="text-center text-xl font-black text-violet-400">#{item.rank}</span><span className="font-bold">{item.key}</span><span className="text-right text-xs text-slate-400">{item.workCount.toLocaleString()}作品<br />{item.searches.toLocaleString()}検索</span></Link>) : <p className="rounded-xl border border-dashed border-slate-700 py-16 text-center text-slate-500">現在、この期間のランキング対象データはありません。</p>}</div></main>;
}
