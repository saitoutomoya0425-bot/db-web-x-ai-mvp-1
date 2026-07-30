import { redirect } from "next/navigation";
import { WorksManager } from "@/components/admin/works-manager";
import { createClient } from "@/lib/supabase/server";

export default async function AdminWorksPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.app_metadata?.role !== "admin") redirect("/admin/login?next=/admin/works");
  return <main className="mx-auto max-w-7xl px-5 py-8">
    <p className="text-xs font-bold tracking-widest text-violet-400">CATALOG</p>
    <h1 className="mt-2 text-3xl font-black">作品管理</h1>
    <p className="mt-2 text-sm text-slate-400">少数の作品はここで追加・編集できます。大量登録はCSVインポートを使用してください。</p>
    <div className="mt-7"><WorksManager /></div>
  </main>;
}
