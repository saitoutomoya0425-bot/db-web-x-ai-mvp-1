import { redirect } from "next/navigation";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { SourceReview } from "@/components/admin/source-review";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export default async function SourcesPage({ searchParams }: { searchParams: Promise<{ page?:string;bucket?:string }> }) {
  const supabase = await createClient();
  const { data:{ user } } = await supabase.auth.getUser();
  if (!user || user.app_metadata?.role !== "admin") redirect("/admin/login");
  const params=await searchParams,page=Math.max(1,Number(params.page)||1),size=100;
  const buckets=["high","medium","low","duplicate","invalid","unprocessed"] as const;
  const bucket:typeof buckets[number]|"all"=params.bucket&&buckets.includes(params.bucket as typeof buckets[number])?params.bucket as typeof buckets[number]:"all";
  let itemQuery=supabase.from("source_items").select("id,source,product_code,title,actress_name,maker_name,series_name,observed_at,confidence,extraction_status,duplicate_of,duplicate_video_id",{count:"estimated"}).eq("status","pending");
  if(bucket!=="all")itemQuery=itemQuery.eq("review_bucket",bucket);
  const [{data:items,count},{data:source},{data:runs}] = await Promise.all([
    itemQuery.order("observed_at",{ascending:false}).range((page-1)*size,page*size-1),
    supabase.from("collection_sources").select("*").eq("source","x").maybeSingle(),
    supabase.from("collection_runs").select("*").eq("source","x").order("started_at",{ascending:false}).limit(5),
  ]);
  return <main className="mx-auto max-w-7xl px-5 py-10"><Breadcrumbs items={[{name:"管理",href:"/admin"},{name:"収集候補"}]} /><h1 className="mt-6 text-3xl font-black">収集候補レビュー</h1><p className="mt-2 text-sm text-slate-400">表示対象 {(count??0).toLocaleString()}件・X最終実行 {source?.last_run_at ? new Date(source.last_run_at).toLocaleString("ja-JP") : "未実行"}</p><nav className="mt-5 flex flex-wrap gap-2">{[["all","すべて"],["high","高信頼"],["medium","中信頼"],["low","低信頼"],["duplicate","重複"],["invalid","不足"],["unprocessed","未抽出"]].map(([key,label])=><a key={key} href={`?bucket=${key}`} className={`rounded-full px-4 py-2 text-sm ${bucket===key?"bg-violet-600":"bg-slate-900"}`}>{label}</a>)}</nav>{source?.last_error && <p className="mt-4 rounded-lg bg-red-950/40 p-3 text-sm text-red-300">{source.last_error}</p>}<section className="mt-8"><SourceReview items={items??[]} /></section><div className="mt-5 flex gap-2">{page>1&&<a href={`?bucket=${bucket}&page=${page-1}`} className="rounded bg-slate-800 px-4 py-2">前へ</a>}{(items?.length??0)===size&&<a href={`?bucket=${bucket}&page=${page+1}`} className="rounded bg-violet-600 px-4 py-2">次へ</a>}</div><section className="mt-10"><h2 className="font-bold">最近の収集実行</h2><div className="mt-3 space-y-2">{runs?.map(run=><p key={run.id} className="rounded-lg bg-slate-900 p-3 text-sm">{run.status} — 取得 {run.fetched_count} / 登録 {run.accepted_count} / 重複 {run.duplicate_count}</p>)}</div></section></main>;
}
