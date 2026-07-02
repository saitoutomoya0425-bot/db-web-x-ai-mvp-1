import { redirect } from "next/navigation";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { RefreshMetricsButton } from "@/components/admin/refresh-metrics-button";
import { createClient } from "@/lib/supabase/server";

export const dynamic="force-dynamic";
export default async function AnalyticsPage() {
  const supabase=await createClient();
  const {data:{user}}=await supabase.auth.getUser();
  if(!user||user.app_metadata?.role!=="admin") redirect("/admin/login");
  const [{data:metricRows},{data:works},{data:actresses},{data:keywords},{data:recentRuns}]=await Promise.all([
    supabase.rpc("get_admin_operations_metrics"),
    supabase.from("discovery_metrics").select("*").eq("entity_type","work").eq("period","week").order("score",{ascending:false}).limit(15),
    supabase.from("discovery_metrics").select("*").eq("entity_type","actress").eq("period","week").order("score",{ascending:false}).limit(15),
    supabase.from("discovery_metrics").select("*").eq("entity_type","keyword").eq("period","week").order("rank").limit(15),
    supabase.from("ai_extraction_runs").select("status,total_tokens,latency_ms,created_at,error_message").order("created_at",{ascending:false}).limit(10),
  ]);
  const m=metricRows?.[0]??{collected:0,candidates:0,approved:0,rejected:0,duplicates:0,errors:0,ai_requests:0,input_tokens:0,output_tokens:0,affiliate_clicks:0};
  const decided=Number(m.approved)+Number(m.rejected),rate=(value:number)=>decided?`${(Number(value)/decided*100).toFixed(1)}%`:"0.0%";
  const cards=[["収集件数",m.collected],["品番候補数",m.candidates],["承認率",rate(m.approved)],["却下率",rate(m.rejected)],["重複率",Number(m.candidates)?`${(Number(m.duplicates)/Number(m.candidates)*100).toFixed(1)}%`:"0.0%"],["エラー件数",m.errors],["AI API利用",`${Number(m.ai_requests).toLocaleString()}回 / ${(Number(m.input_tokens)+Number(m.output_tokens)).toLocaleString()} tokens`],["アフィリエイトクリック",m.affiliate_clicks]];
  return <main className="mx-auto max-w-7xl px-5 py-10"><Breadcrumbs items={[{name:"管理",href:"/admin"},{name:"分析"}]}/><div className="mt-6 flex flex-wrap items-center justify-between gap-4"><div><h1 className="text-3xl font-black">運用・アクセス分析</h1><p className="mt-2 text-sm text-slate-400">収集、AI整備、検索、収益導線を横断して確認します。</p></div><RefreshMetricsButton/></div><div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{cards.map(([label,value])=><div key={String(label)} className="rounded-xl border border-slate-800 bg-slate-900/50 p-5"><p className="text-xs text-slate-500">{label}</p><p className="mt-2 text-2xl font-black">{typeof value==="number"?value.toLocaleString():value}</p></div>)}</div><div className="mt-8 grid gap-6 lg:grid-cols-3"><Panel title="人気検索語" rows={(keywords??[]).map(row=>({key:row.entity_key,value:`${row.searches}回`}))}/><Panel title="人気作品・CTR" rows={(works??[]).map(row=>({key:row.entity_key,value:`検索 ${row.searches} / click ${row.clicks} / CTR ${Number(row.searches)?(Number(row.clicks)/Number(row.searches)*100).toFixed(1):"0.0"}%`}))}/><Panel title="人気女優" rows={(actresses??[]).map(row=>({key:row.entity_key,value:`score ${Number(row.score).toFixed(1)}`}))}/></div><section className="mt-8 rounded-2xl border border-slate-800 bg-slate-900/40 p-5"><h2 className="font-bold">直近のAI処理</h2><div className="mt-4 space-y-2">{recentRuns?.length?recentRuns.map((run,index)=><p key={`${run.created_at}-${index}`} className="grid gap-2 border-b border-slate-800 py-2 text-xs sm:grid-cols-4"><span>{run.status}</span><span>{run.total_tokens.toLocaleString()} tokens</span><span>{run.latency_ms.toLocaleString()} ms</span><span className="truncate text-red-300">{run.error_message??"-"}</span></p>):<p className="text-sm text-slate-500">AI処理履歴はありません。</p>}</div></section></main>;
}
function Panel({title,rows}:{title:string;rows:{key:string;value:string}[]}){return <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5"><h2 className="font-bold">{title}</h2><div className="mt-4 space-y-2">{rows.length?rows.map((row,index)=><div key={`${row.key}-${index}`} className="flex justify-between gap-3 border-b border-slate-800 py-2 text-sm"><span className="truncate">{index+1}. {row.key}</span><span className="shrink-0 text-xs text-slate-400">{row.value}</span></div>):<p className="text-sm text-slate-500">データはまだありません。</p>}</div></section>}
