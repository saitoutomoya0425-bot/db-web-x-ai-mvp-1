import { redirect } from "next/navigation";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { AiQualitySettings } from "@/components/admin/ai-quality-settings";
import { createClient } from "@/lib/supabase/server";

export const dynamic="force-dynamic";
export default async function AiQualityPage(){
  const supabase=await createClient(),{data:{user}}=await supabase.auth.getUser();
  if(!user||user.app_metadata?.role!=="admin")redirect("/admin/login");
  const [{data:settings},{data:snapshots}]=await Promise.all([
    supabase.from("ai_quality_settings").select("*").eq("id",true).single(),
    supabase.from("ai_quality_snapshots").select("*").order("calculated_at",{ascending:false}).limit(20),
  ]);
  const initial=settings??{high_threshold:.9,medium_threshold:.65,auto_approve_enabled:false,auto_approve_threshold:.98,minimum_evaluated_samples:200,minimum_precision:.98};
  return <main className="mx-auto max-w-6xl px-5 py-10"><Breadcrumbs items={[{name:"管理",href:"/admin"},{name:"AI品質管理"}]}/><h1 className="mt-6 text-3xl font-black">AI品質管理</h1><p className="mt-2 text-sm text-slate-400">修正・承認結果からモデル精度を継続評価し、安全条件を満たさない場合は自動承認を停止します。</p><div className="mt-8"><AiQualitySettings initial={initial}/></div><section className="mt-8 rounded-2xl border border-slate-800 bg-slate-900/40 p-6"><h2 className="font-bold">評価履歴</h2><div className="mt-4 overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm"><thead className="text-slate-500"><tr><th>モデル</th><th>サンプル</th><th>承認率</th><th>修正率</th><th>高信頼精度</th><th>ゲート</th><th>日時</th></tr></thead><tbody>{snapshots?.map(row=><tr key={row.id} className="border-t border-slate-800"><td className="py-3">{row.model}</td><td>{row.sample_count}</td><td>{percent(row.approval_rate)}</td><td>{percent(row.correction_rate)}</td><td>{percent(row.high_confidence_precision)}</td><td className={row.passed_gate?"text-emerald-400":"text-amber-400"}>{row.passed_gate?"通過":"未通過"}</td><td className="text-xs text-slate-500">{new Date(row.calculated_at).toLocaleString("ja-JP")}</td></tr>)}</tbody></table>{!snapshots?.length&&<p className="py-8 text-center text-slate-500">評価履歴はまだありません。</p>}</div></section></main>;
}
function percent(value:number|null){return value==null?"-":`${(Number(value)*100).toFixed(1)}%`}
