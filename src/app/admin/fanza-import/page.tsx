import { redirect } from "next/navigation";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { FanzaImportPanel } from "@/components/admin/fanza-import-panel";
import { fanzaConfiguration } from "@/lib/fanza/client";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function FanzaImportPage() {
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || user.app_metadata?.role !== "admin") redirect("/admin/login");
  const config = fanzaConfiguration();
  const { data: source } = await client.from("data_sources").select("id").eq("name", "FANZA Webサービス").maybeSingle();
  const { data: items } = source
    ? await client.from("source_products").select("id,external_product_id,original_product_code,product_code,preview_status,review_status,normalized_data,fetched_at,error_message").eq("data_source_id", source.id).eq("review_status", "pending").order("fetched_at", { ascending: false }).limit(100)
    : { data: [] };
  return <main className="mx-auto max-w-6xl px-5 py-10">
    <Breadcrumbs items={[{ name: "管理", href: "/admin" }, { name: "FANZA少量取得" }]} />
    <h1 className="mt-6 text-3xl font-black">FANZA Webサービス少量取得</h1>
    <p className="mt-2 text-sm text-slate-400">公式API → 生データ保存 → 正規化 → 差分確認 → 手動承認の順で処理します。</p>
    <div className={`mt-5 rounded-xl border p-4 text-sm ${config.configured ? "border-emerald-800 bg-emerald-950/30 text-emerald-200" : "border-amber-800 bg-amber-950/30 text-amber-200"}`}>
      {config.configured ? `認証情報設定済み（${config.site} / ${config.service} / ${config.floor}）` : "認証情報未設定のため取得テスト待ち"}
    </div>
    <FanzaImportPanel configured={config.configured} items={items ?? []} />
  </main>;
}
