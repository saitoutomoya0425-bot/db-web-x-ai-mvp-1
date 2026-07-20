import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { LoadMoreWorkGrid } from "@/components/load-more-work-grid";
import { getTagWorks } from "@/lib/queries/discovery";

const decode = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };
export async function generateMetadata({ params }: { params: Promise<{ name: string }> }): Promise<Metadata> {
  const name = decode((await params).name);
  return { title: `${name}作品一覧`, description: `${name}タグの人気作品・新着作品を一覧で紹介します。`, alternates: { canonical: `/tag/${encodeURIComponent(name)}` } };
}
export default async function TagPage({ params }: { params: Promise<{ name: string }> }) {
  const name = decode((await params).name);
  const works = await getTagWorks(name, 96, 0);
  if (!works.length) notFound();
  return <main className="mx-auto max-w-7xl px-5 py-12"><Breadcrumbs items={[{ name: "トップ", href: "/" }, { name: "タグ" }, { name }]} /><h1 className="mt-6 text-3xl font-black">「{name}」の作品</h1><LoadMoreWorkGrid works={works} className="mt-8" /></main>;
}
