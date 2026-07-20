import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LoadMoreWorkGrid } from "@/components/load-more-work-grid";
import { createClient } from "@/lib/supabase/server";
import { toWorkDetails } from "@/lib/queries/public-works";

function decodeName(value: string) { return decodeURIComponent(value); }
export async function generateMetadata({ params }: { params: Promise<{ name: string }> }): Promise<Metadata> {
  const name = decodeName((await params).name);
  return { title: `${name}シリーズの作品`, description: `${name}シリーズの作品一覧です。`, alternates: { canonical: `/series/${encodeURIComponent(name)}` } };
}
export default async function SeriesPage({ params }: { params: Promise<{ name: string }> }) {
  const name = decodeName((await params).name);
  const supabase = await createClient();
  const { data } = await supabase.from("videos").select("*").eq("is_published", true).eq("series_name", name).order("popularity", { ascending: false }).limit(100);
  const works = toWorkDetails(data);
  if (!works.length) notFound();
  return <main className="mx-auto max-w-7xl px-5 py-12"><Link href="/" className="text-sm text-slate-400">← トップへ戻る</Link><h1 className="mt-6 text-3xl font-black">{name}シリーズ</h1><p className="mt-2 text-slate-400">{works.length}件</p><LoadMoreWorkGrid works={works} className="mt-8" /></main>;
}
