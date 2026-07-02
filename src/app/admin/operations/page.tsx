import { redirect } from "next/navigation";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { OperationsPanel } from "@/components/admin/operations-panel";
import { createClient } from "@/lib/supabase/server";

export const dynamic="force-dynamic";
export default async function OperationsPage(){
  const supabase=await createClient(),{data:{user}}=await supabase.auth.getUser();
  if(!user||user.app_metadata?.role!=="admin")redirect("/admin/login");
  const {data}=await supabase.from("affiliate_settings").select("enabled,url_template").eq("id",true).maybeSingle();
  return <main className="mx-auto max-w-6xl px-5 py-10"><Breadcrumbs items={[{name:"管理",href:"/admin"},{name:"運用操作"}]}/><h1 className="mt-6 text-3xl font-black">運用操作</h1><p className="mt-2 text-sm text-slate-400">収集・AI整備・集計・収益リンクを管理者権限で手動実行できます。</p><div className="mt-8"><OperationsPanel affiliate={data??{enabled:false,url_template:null}}/></div></main>;
}
