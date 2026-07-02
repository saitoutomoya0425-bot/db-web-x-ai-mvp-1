import type { Metadata } from "next";
import Link from "next/link";
import { Tags } from "lucide-react";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { getGenreFacets } from "@/lib/queries/catalog";
export const metadata:Metadata={title:"ジャンル一覧",description:"人気ジャンルから作品を探せます。",alternates:{canonical:"/genres"}};
export default async function GenresPage(){const items=await getGenreFacets(200);return <main className="mx-auto max-w-6xl px-5 py-12"><Breadcrumbs items={[{name:"トップ",href:"/"},{name:"ジャンル一覧"}]}/><h1 className="mt-6 text-3xl font-black">ジャンル一覧</h1><div className="mt-8 flex flex-wrap gap-3">{items.map(item=><Link key={item.name} href={`/genre/${encodeURIComponent(item.name)}`} className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900 px-4 py-2.5 hover:border-violet-500"><Tags className="size-4 text-violet-400"/><span>{item.name}</span><span className="text-xs text-slate-500">{Number(item.work_count).toLocaleString()}</span></Link>)}</div></main>}
