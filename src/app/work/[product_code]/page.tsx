import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CalendarDays, Clock3, ExternalLink, Factory, Film, ImageIcon, PlayCircle, Tags, UserRound } from "lucide-react";
import { PublicWorkCard } from "@/components/public-work-card";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { getRelatedWorks, getWorkByCode } from "@/lib/queries/public-works";
import type { WorkDetail } from "@/types/database";

export async function generateMetadata({ params }: { params: Promise<{ product_code: string }> }): Promise<Metadata> {
  const work = await getWorkByCode((await params).product_code);
  if (!work) return { title: "作品が見つかりません | おかずDB", robots: { index: false } };
  const actress = work.actresses?.name ? `、出演：${work.actresses.name}` : "";
  const description = work.description?.slice(0, 155) || `${work.product_code}「${work.title}」の作品情報${actress}。ジャケット、サンプル画像、メーカー、シリーズ、関連作品を掲載。`;
  return {
    title: `${work.product_code} ${work.title} | おかずDB`,
    description,
    alternates: { canonical: `/work/${encodeURIComponent(work.product_code)}` },
    openGraph: { title: `${work.product_code} ${work.title}`, description, type: "video.movie", url: `/work/${encodeURIComponent(work.product_code)}`, images: work.thumbnail_url ? [{ url: work.thumbnail_url, alt: `${work.title} ジャケット` }] : [] },
    twitter: { card: "summary_large_image", title: `${work.product_code} ${work.title}`, description, images: work.thumbnail_url ? [work.thumbnail_url] : [] },
  };
}

function InfoRow({ icon: Icon, label, children }: { icon: typeof Film; label: string; children: React.ReactNode }) {
  return <div className="grid grid-cols-[24px_88px_1fr] items-start gap-2 border-b border-slate-800 py-3 last:border-0"><Icon className="mt-0.5 size-4 text-violet-400" /><dt className="text-sm text-slate-500">{label}</dt><dd className="min-w-0 text-sm font-medium text-slate-200">{children}</dd></div>;
}

function WorkSection({ title, works }: { title: string; works: WorkDetail[] }) {
  if (!works.length) return null;
  return <section className="mt-14"><h2 className="mb-6 text-xl font-bold sm:text-2xl">{title}</h2><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{works.map((work) => <PublicWorkCard key={work.id} work={work} />)}</div></section>;
}

export default async function WorkPage({ params, searchParams }: { params: Promise<{ product_code: string }>; searchParams: Promise<{ clicked?: string }> }) {
  const work = await getWorkByCode((await params).product_code);
  if (!work) notFound();
  const { actressWorks, makerWorks, seriesWorks, relatedWorks } = await getRelatedWorks(work);
  const { clicked } = await searchParams;
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const samples = (work.sample_images ?? []).filter((url) => url !== work.thumbnail_url);
  const structuredData = {
    "@context": "https://schema.org", "@type": ["Movie", "VideoObject"], name: work.title,
    identifier: work.product_code, description: work.description || `${work.product_code} ${work.title}`,
    thumbnailUrl: work.thumbnail_url ? [work.thumbnail_url] : undefined, image: work.thumbnail_url,
    contentUrl: work.sample_url, uploadDate: work.release_date, dateCreated: work.release_date,
    duration: work.duration ? `PT${work.duration}M` : undefined, genre: work.genre,
    actor: work.actresses ? [{ "@type": "Person", name: work.actresses.name }] : undefined,
    productionCompany: work.makers ? { "@type": "Organization", name: work.makers.name } : undefined,
    url: `${site}/work/${encodeURIComponent(work.product_code)}`,
  };

  return (
    <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-10">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData).replace(/</g, "\\u003c") }} />
      <Breadcrumbs items={[{ name: "トップ", href: "/" }, ...(work.makers?.name ? [{ name: work.makers.name, href: `/maker/${encodeURIComponent(work.makers.name)}` }] : []), { name: work.product_code }]} />
      {clicked && !work.affiliate_url && <p className="mt-4 rounded-xl border border-amber-800 bg-amber-950/30 p-4 text-sm text-amber-200">リンク先は準備中です。クリックは計測されました。</p>}

      <article className="mt-5 grid gap-7 lg:grid-cols-[minmax(0,1.45fr)_minmax(330px,.75fr)] lg:gap-10">
        <div>
          <div className="relative aspect-[16/10] w-full overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl shadow-black/30">
            {work.thumbnail_url ? <Image src={work.thumbnail_url} alt={`${work.title} ジャケット`} fill priority unoptimized sizes="(max-width: 1024px) 100vw, 65vw" className="object-contain" /> : <div className="grid h-full place-items-center"><div className="text-center text-slate-600"><ImageIcon className="mx-auto size-14" /><p className="mt-3 text-sm">ジャケット画像は未登録です</p></div></div>}
          </div>
          {samples.length > 0 && <section className="mt-6"><h2 className="mb-4 flex items-center gap-2 font-bold"><ImageIcon className="size-5 text-violet-400" />サンプル画像</h2><div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{samples.map((url, index) => <a key={`${url}-${index}`} href={url} target="_blank" rel="noreferrer" className="relative aspect-[4/3] overflow-hidden rounded-xl border border-slate-800 bg-slate-900"><Image src={url} alt={`${work.title} サンプル画像 ${index + 1}`} fill unoptimized sizes="(max-width: 640px) 50vw, 25vw" className="object-cover transition hover:scale-105" /></a>)}</div></section>}
        </div>

        <aside className="lg:sticky lg:top-20 lg:self-start">
          <span className="inline-flex rounded-lg bg-violet-950 px-3 py-1.5 font-mono text-sm font-bold text-violet-300">{work.product_code}</span>
          <h1 className="mt-4 text-2xl font-black leading-tight sm:text-3xl">{work.title}</h1>
          <dl className="mt-6 rounded-xl border border-slate-800 bg-slate-900/50 px-4">
            <InfoRow icon={Film} label="品番">{work.product_code}</InfoRow>
            <InfoRow icon={UserRound} label="女優">{work.actresses ? <Link className="text-violet-300 hover:underline" href={`/actress/${encodeURIComponent(work.actresses.name)}`}>{work.actresses.name}</Link> : "未登録"}</InfoRow>
            <InfoRow icon={Factory} label="メーカー">{work.makers ? <Link className="text-violet-300 hover:underline" href={`/maker/${encodeURIComponent(work.makers.name)}`}>{work.makers.name}</Link> : "未登録"}</InfoRow>
            <InfoRow icon={PlayCircle} label="シリーズ">{work.series_name ? <Link className="text-violet-300 hover:underline" href={`/series/${encodeURIComponent(work.series_name)}`}>{work.series_name}</Link> : "未登録"}</InfoRow>
            <InfoRow icon={CalendarDays} label="発売日">{work.release_date ?? "未登録"}</InfoRow>
            <InfoRow icon={Tags} label="ジャンル">{work.genre ? <Link className="text-violet-300 hover:underline" href={`/genre/${encodeURIComponent(work.genre)}`}>{work.genre}</Link> : "未登録"}</InfoRow>
            <InfoRow icon={Clock3} label="再生時間">{work.duration ? `${work.duration}分` : "未登録"}</InfoRow>
          </dl>
          {work.work_tags.length > 0 && <div className="mt-4 flex flex-wrap gap-2">{work.work_tags.flatMap(({ tags }) => tags ? [<Link key={tags.id} href={`/tag/${encodeURIComponent(tags.name)}`} className="rounded-full bg-slate-800 px-3 py-1.5 text-xs text-violet-200 hover:bg-violet-900">#{tags.name}</Link>] : [])}</div>}
          <div className="mt-5 grid gap-3">
            {work.sample_url && <a href={work.sample_url} target="_blank" rel="noreferrer" className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-900 font-bold hover:border-violet-500"><PlayCircle className="size-5" />サンプル動画を見る</a>}
            <a href={`/go/${encodeURIComponent(work.product_code)}?store=fanza`} target="_blank" rel="sponsored noreferrer" className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-red-600 to-orange-500 px-4 font-bold text-white shadow-lg hover:brightness-110"><ExternalLink className="size-5" />FANZAで作品を見る</a>
            <a href={`/go/${encodeURIComponent(work.product_code)}?store=dmm`} target="_blank" rel="sponsored noreferrer" className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-500 px-4 font-bold text-white shadow-lg hover:brightness-110"><ExternalLink className="size-5" />DMMで作品を見る</a>
            {!work.affiliate_url && <p className="text-center text-xs text-slate-500">リンク先は仮設定です</p>}
          </div>
        </aside>
      </article>

      {work.description && <section className="mt-10 rounded-2xl border border-slate-800 bg-slate-900/40 p-5 sm:p-7"><h2 className="mb-3 text-xl font-bold">作品詳細</h2><p className="whitespace-pre-wrap text-sm leading-7 text-slate-300">{work.description}</p></section>}
      <WorkSection title={`${work.actresses?.name ?? "この女優"}の他作品`} works={actressWorks} />
      <WorkSection title={`${work.makers?.name ?? "同じメーカー"}の作品`} works={makerWorks} />
      <WorkSection title={`${work.series_name ?? "同じシリーズ"}の作品`} works={seriesWorks} />
      <WorkSection title="人気の関連作品" works={relatedWorks} />
    </main>
  );
}
