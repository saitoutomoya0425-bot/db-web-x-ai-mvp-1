import Link from "next/link";
import { Activity, Bot, Database, Factory, MousePointerClick, Search, TriangleAlert, Users } from "lucide-react";
import { redirect } from "next/navigation";
import { PublicWorkCard } from "@/components/public-work-card";
import { SignOutButton } from "@/components/admin/sign-out-button";
import { getPopularWorksPeriod } from "@/lib/queries/public-works";
import { createClient } from "@/lib/supabase/server";

export const dynamic="force-dynamic";
export default async function AdminPage(){
  const supabase=await createClient(),{data:{user}}=await supabase.auth.getUser();
  if(!user||user.app_metadata?.role!=="admin")redirect("/admin/login");
  const [counts,metricResult,aiResult,importResult,popular,rising]=await Promise.all([
    Promise.all([
      supabase.from("videos").select("id",{count:"estimated",head:true}),
      supabase.from("actresses").select("id",{count:"estimated",head:true}),
      supabase.from("makers").select("id",{count:"estimated",head:true}),
    ]),
    supabase.rpc("get_admin_operations_metrics"),
    supabase.from("source_items").select("id,extraction_status",{count:"estimated"}).eq("status","pending").limit(1),
    supabase.from("import_jobs").select("id,file_name,status,imported_count,failed_count,updated_at").order("updated_at",{ascending:false}).limit(5),
    getPopularWorksPeriod(4,0,null).catch(()=>[]),
    getPopularWorksPeriod(4,0,7).catch(()=>[]),
  ]);
  const [videos,actresses,makers]=counts.map(result=>result.count??0),metrics=metricResult.data?.[0];
  const searches=Number(metrics?.candidates??0),clicks=Number(metrics?.affiliate_clicks??0),ctr=searches?`${(clicks/searches*100).toFixed(2)}%`:"0.00%";
  return <main className="mx-auto max-w-7xl px-5 py-8"><div className="flex items-start justify-between gap-4"><div><p className="text-xs font-bold tracking-widest text-violet-400">OVERVIEW</p><h1 className="mt-2 text-3xl font-black">サイト全体ダッシュボード</h1><p className="mt-2 text-sm text-slate-400">データ、流入、AI処理、収益導線の現在地です。</p></div><SignOutButton/></div>
    <div className="mt-8 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Stat icon={Database} label="作品数" value={videos}/><Stat icon={Users} label="女優数" value={actresses}/><Stat icon={Factory} label="メーカー数" value={makers}/><Stat icon={Bot} label="AI確認待ち" value={aiResult.count??0}/></div>
    <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Stat icon={Search} label="検索・候補数" value={searches}/><Stat icon={MousePointerClick} label="クリック数" value={clicks}/><Stat icon={Activity} label="CTR" value={ctr}/><Stat icon={TriangleAlert} label="エラー" value={Number(metrics?.errors??0)} tone={Number(metrics?.errors??0)>0?"warn":"normal"}/></div>
    <div className="mt-8 grid gap-6 xl:grid-cols-2"><Ranking title="人気作品ランキング" href="/ranking" works={popular}/><Ranking title="人気急上昇（7日）" href="/ranking?period=7" works={rising}/></div>
    <section className="mt-8 rounded-2xl border border-slate-800 bg-slate-900/40 p-6"><div className="flex items-center justify-between"><h2 className="font-bold">最近のCSVインポート</h2><Link href="/admin/import-csv" className="text-sm text-violet-300">インポート画面へ →</Link></div><div className="mt-4 space-y-2">{importResult.data?.length?importResult.data.map(job=><div key={job.id} className="grid gap-2 rounded-lg bg-slate-950 p-3 text-sm sm:grid-cols-[1fr_auto_auto]"><span className="truncate">{job.file_name}</span><span className="text-slate-400">{job.status}</span><span className="text-slate-400">登録 {job.imported_count.toLocaleString()} / 失敗 {job.failed_count.toLocaleString()}</span></div>):<p className="text-sm text-slate-500">履歴はまだありません。</p>}</div></section>
  </main>;
}
function Stat({icon:Icon,label,value,tone="normal"}:{icon:typeof Database;label:string;value:number|string;tone?:"normal"|"warn"}){return <div className={`rounded-2xl border p-5 ${tone==="warn"?"border-amber-900 bg-amber-950/20":"border-slate-800 bg-slate-900/40"}`}><Icon className={`size-5 ${tone==="warn"?"text-amber-400":"text-violet-400"}`}/><p className="mt-4 text-xs text-slate-500">{label}</p><p className="mt-1 text-3xl font-black">{typeof value==="number"?value.toLocaleString():value}</p></div>}
function Ranking({title,href,works}:{title:string;href:string;works:Awaited<ReturnType<typeof getPopularWorksPeriod>>}){return <section className="rounded-2xl border border-slate-800 bg-slate-900/30 p-5"><div className="flex justify-between"><h2 className="font-bold">{title}</h2><Link href={href} className="text-xs text-violet-300">公開ページ →</Link></div>{works.length?<div className="mt-4 grid gap-3 sm:grid-cols-2">{works.map((work,index)=><PublicWorkCard key={work.id} work={work} rank={index+1} count={work.search_count}/>)}</div>:<p className="mt-8 text-center text-sm text-slate-500">集計データはまだありません。</p>}</section>}
