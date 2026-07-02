import type { Metadata } from "next";
import Link from "next/link";
import { PublicWorkCard } from "@/components/public-work-card";
import { createClient } from "@/lib/supabase/server";
import { toWorkDetails } from "@/lib/queries/public-works";

function decodeName(value: string) { try { return decodeURIComponent(value); } catch { return value; } }
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const name = decodeName((await params).id);
  return { title: `${name}の作品一覧 | おかずDB`, description: `${name}の作品を品番・女優・シリーズから探せます。`, alternates: { canonical: `/maker/${encodeURIComponent(name)}` } };
}
export default async function MakerPage({ params }: { params: Promise<{ id: string }> }) {
  const name = decodeName((await params).id);
  const supabase = await createClient();
  const { data } = await supabase.from("videos").select("*").eq("maker_name", name).order("popularity", { ascending: false }).limit(100);
  const works = toWorkDetails(data);
  return <main className="mx-auto max-w-6xl px-5 py-12"><Link href="/" className="text-sm text-slate-400">← トップへ戻る</Link><h1 className="mt-6 text-3xl font-black">{name}の作品</h1><p className="mt-2 text-slate-400">{works.length}件</p>{works.length ? <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">{works.map((work) => <PublicWorkCard key={work.id} work={work} />)}</div> : <p className="mt-10 text-slate-500">作品が見つかりません。</p>}</main>;
}
