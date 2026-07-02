import type { Metadata } from "next";
import Link from "next/link";
import { Factory, ListVideo, Users } from "lucide-react";
import { Breadcrumbs } from "@/components/breadcrumbs";

export const metadata: Metadata = { title: "女優・メーカー・シリーズランキング", description: "検索とクリックをもとにした各種人気ランキングです。", alternates: { canonical: "/rankings" } };
const items = [
  { type: "actress", label: "女優ランキング", description: "検索・作品人気から注目女優を集計", icon: Users },
  { type: "maker", label: "メーカーランキング", description: "メーカー別の人気作品を集計", icon: Factory },
  { type: "series", label: "シリーズランキング", description: "人気シリーズをまとめて確認", icon: ListVideo },
];
export default function RankingsPage() {
  return <main className="mx-auto max-w-6xl px-5 py-12"><Breadcrumbs items={[{ name: "トップ", href: "/" }, { name: "ランキング" }]} /><h1 className="mt-6 text-3xl font-black">人気ランキング</h1><p className="mt-3 text-slate-400">検索・クリック・作品人気をもとに定期集計しています。</p><div className="mt-8 grid gap-5 md:grid-cols-3">{items.map(({ type, label, description, icon: Icon }) => <Link key={type} href={`/rankings/${type}`} className="rounded-2xl border border-slate-800 bg-slate-900/50 p-7 transition hover:border-violet-700"><Icon className="size-8 text-violet-400" /><h2 className="mt-5 text-xl font-bold">{label}</h2><p className="mt-2 text-sm text-slate-400">{description}</p></Link>)}</div></main>;
}
