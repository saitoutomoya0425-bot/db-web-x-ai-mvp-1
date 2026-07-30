import { FileSpreadsheet, Info } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CsvImporter } from "@/components/admin/csv-importer-v2";
import { SignOutButton } from "@/components/admin/sign-out-button";
import { createClient } from "@/lib/supabase/server";

export default async function ImportCsvPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.app_metadata?.role !== "admin") redirect("/admin/login");
  return (
    <main className="mx-auto max-w-4xl px-5 py-10">
      <div className="mb-8 flex items-start justify-between gap-4"><div><p className="mb-2 text-sm font-medium text-violet-400">ADMIN</p><h1 className="flex items-center gap-3 text-3xl font-black"><FileSpreadsheet className="size-8" />CSVインポート</h1><p className="mt-3 text-sm text-slate-400">大容量CSVを分割登録します。同じ品番はスキップされ、中断時は同じファイルから再開できます。</p></div><SignOutButton /></div>
      <section className="rounded-2xl border border-slate-800 bg-slate-950 p-5 shadow-xl sm:p-7"><CsvImporter /></section>
      <section className="mt-6 rounded-xl border border-slate-800 bg-slate-900/40 p-5">
        <h2 className="flex items-center gap-2 font-semibold"><Info className="size-5 text-violet-400" />CSVフォーマット</h2>
        <p className="mt-3 text-sm leading-6 text-slate-400"><code>product_code</code> は必須で、新規登録では <code>title</code> も必須です。更新時の空欄は既存値を保持します。明示的に削除する場合だけ <code>clear_fields</code> に項目名を指定してください。<code>sample_images</code> はURLを <code>|</code> で区切るか、JSON配列で指定できます。</p>
        <Link href="/templates/videos-import-template.csv" download className="mt-4 inline-flex rounded-lg border border-violet-700 px-4 py-2 text-sm font-bold text-violet-300 hover:bg-violet-950/40">実データ用CSVテンプレートをダウンロード</Link>
        <div className="mt-4 overflow-x-auto rounded-lg bg-slate-950 p-4"><code className="whitespace-nowrap text-xs text-slate-300">product_code,title,actress_name,actress_name_kana,maker_name,series_name,label_name,genre,tags,duration,release_date,sample_images,card_thumbnail_url,thumbnail_url,video_url,affiliate_url,description,popularity,favorite_count,clear_fields</code></div>
      </section>
    </main>
  );
}
