import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CalendarDays, Clock3, ExternalLink, Factory, Film, ImageIcon, PlayCircle, Tags, UserRound } from "lucide-react";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { ResolvedThumbnail } from "@/components/resolved-thumbnail";
import { VideoViewTracker } from "@/components/video-view-tracker";
import { SampleVideoTrigger } from "@/components/sample-video-trigger";
import { RecentlyViewedCarousel, RecentlyViewedRecorder } from "@/components/recently-viewed";
import { WorkCarousel } from "@/components/work-carousel";
import { getRelatedWorks, getWorkByCode } from "@/lib/queries/public-works";
import {
  getLegacyRuntimeThumbnailOverride,
  officialFanzaImageUrl,
} from "@/lib/fanza/media";
import { resolveSalesUrl } from "@/lib/fanza/sales-url";
import {
  resolveThumbnailPresentation,
  resolvedThumbnailUrl,
} from "@/lib/thumbnail/presentation";
import { thumbnailStructuredDataImage } from "@/lib/thumbnail/structured-data";
import type { WorkDetail } from "@/types/database";

export async function generateMetadata({ params }: { params: Promise<{ product_code: string }> }): Promise<Metadata> {
  const work = await getWorkByCode((await params).product_code);
  if (!work) return { title: "作品が見つかりません", robots: { index: false } };
  const actressNames = work.actress_list?.length
    ? work.actress_list.map((actress) => actress.name).join("、")
    : work.actresses?.name ?? "";
  const actress = actressNames ? `、出演：${actressNames}` : "";
  const description = work.description?.slice(0, 155) || `${work.product_code}「${work.title}」の作品情報${actress}。ジャケット、サンプル画像、メーカー、シリーズ、関連作品を掲載。`;
  const ogImage = "/opengraph-image";
  return {
    title: `${work.product_code} ${work.title}`,
    description,
    alternates: { canonical: `/work/${encodeURIComponent(work.product_code)}` },
    openGraph: { title: `${work.product_code} ${work.title}`, description, type: "video.movie", url: `/work/${encodeURIComponent(work.product_code)}`, images: [{ url: ogImage, alt: work.thumbnail_url ? `${work.title} ジャケット` : "おかずDB" }] },
    twitter: { card: "summary_large_image", title: `${work.product_code} ${work.title}`, description, images: [ogImage] },
  };
}

function InfoRow({ icon: Icon, label, children }: { icon: typeof Film; label: string; children: React.ReactNode }) {
  return <div className="grid grid-cols-[22px_76px_1fr] items-start gap-3 border-b border-white/5 py-3.5 last:border-0"><Icon className="mt-0.5 size-4 text-violet-300/80" /><dt className="text-[12px] font-medium leading-6 text-slate-500">{label}</dt><dd className="min-w-0 break-words text-sm font-medium leading-6 text-slate-200">{children}</dd></div>;
}

function WorkSection({ title, description, works, videoId, source }: { title: string; description?: string; works: WorkDetail[]; videoId: string; source: string }) {
  if (!works.length) return null;
  return <WorkCarousel title={title} description={description} works={works} relatedTracking={{ videoId, source }} className="mt-14 px-0 sm:px-0" />;
}

export default async function WorkPage({ params }: { params: Promise<{ product_code: string }> }) {
  const work = await getWorkByCode((await params).product_code);
  if (!work) notFound();
  const { actressWorks, makerWorks, seriesWorks, relatedWorks } = await getRelatedWorks(work);
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const thumbnail = resolveThumbnailPresentation({
    code: work.product_code,
    legacy_runtime_override: getLegacyRuntimeThumbnailOverride(work.product_code),
    legacy_card_url: work.card_thumbnail_url,
    legacy_thumbnail_url: work.thumbnail_url,
  });
  const thumbnailUrl = resolvedThumbnailUrl(thumbnail);
  const structuredThumbnail = thumbnailStructuredDataImage(thumbnail, site);
  const samples = (work.sample_images ?? [])
    .map(officialFanzaImageUrl)
    .filter((url): url is string => Boolean(url && url !== thumbnailUrl))
    .slice(0, 12);
  const salesLink = resolveSalesUrl(work.affiliate_url, work.official_url ?? null);
  const actressList = work.actress_list?.length
    ? work.actress_list
    : work.actresses
      ? [work.actresses]
      : [];
  const structuredData = {
    "@context": "https://schema.org", "@type": ["Movie", "VideoObject"], name: work.title,
    identifier: work.product_code, description: work.description || `${work.product_code} ${work.title}`,
    ...structuredThumbnail,
    contentUrl: work.sample_url, uploadDate: work.release_date, dateCreated: work.release_date,
    duration: work.duration ? `PT${work.duration}M` : undefined, genre: work.genre,
    actor: actressList.length ? actressList.map((actress) => ({ "@type": "Person", name: actress.name })) : undefined,
    productionCompany: work.makers ? { "@type": "Organization", name: work.makers.name } : undefined,
    url: `${site}/work/${encodeURIComponent(work.product_code)}`,
  };

  return (
    <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-10">
      <VideoViewTracker videoId={work.id} />
      <RecentlyViewedRecorder item={{ product_code: work.product_code, title: work.title, card_thumbnail_url: work.card_thumbnail_url ?? null, thumbnail_url: work.thumbnail_url, actress_name: actressList[0]?.name ?? null, maker_name: work.makers?.name ?? null }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData).replace(/</g, "\\u003c") }} />
      <Breadcrumbs items={[{ name: "トップ", href: "/" }, ...(work.makers?.name ? [{ name: work.makers.name, href: `/maker/${encodeURIComponent(work.makers.name)}` }] : []), { name: work.product_code }]} />

      <article className="mt-5 grid gap-7 lg:grid-cols-[minmax(0,1.6fr)_minmax(320px,.7fr)] lg:gap-10">
        <div>
          <ResolvedThumbnail
            resolution={thumbnail}
            alt={`${work.title} ジャケット`}
            sizes="(max-width: 1024px) min(100vw, 560px), 560px"
            priority
            className="relative mx-auto aspect-[3/4] w-full max-w-[560px] overflow-hidden rounded-[30px] border border-white/10 bg-white/[0.035] shadow-2xl shadow-black/25 lg:max-h-[72vh]"
            imageClassName="opacity-0 animate-[okazuImageIn_.35s_ease-out_forwards]"
            placeholder={<div className="grid h-full place-items-center"><div className="text-center text-slate-600"><ImageIcon className="mx-auto size-14" /><p className="mt-3 text-sm">画像は掲載していません</p></div></div>}
          >
            <SampleVideoTrigger url={work.sample_url} title={work.title} />
          </ResolvedThumbnail>
          {samples.length > 0 && <section className="mt-6"><h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-300"><ImageIcon className="size-4 text-violet-300" />サンプル画像</h2><div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4">{samples.map((url, index) => <a key={`${url}-${index}`} href={url} target="_blank" rel="noreferrer" className="relative aspect-[4/3] overflow-hidden rounded-xl border border-white/5 bg-white/[0.035] transition hover:border-white/15 active:scale-[0.985]"><Image src={url} alt={`${work.title} サンプル画像 ${index + 1}`} fill unoptimized sizes="(max-width: 640px) 33vw, 18vw" className="object-cover opacity-0 transition hover:scale-[1.025] animate-[okazuImageIn_.35s_ease-out_forwards]" /></a>)}</div></section>}
        </div>

        <aside className="lg:sticky lg:top-20 lg:self-start">
          <span className="inline-flex rounded-full border border-violet-400/15 bg-violet-400/10 px-3 py-1.5 font-mono text-xs font-bold tracking-[0.16em] text-violet-200">{work.product_code}</span>
          <h1 className="mt-4 text-2xl font-black leading-tight tracking-tight sm:text-3xl">{work.title}</h1>
          <dl className="mt-6 rounded-2xl border border-white/10 bg-white/[0.035] px-4 shadow-sm shadow-black/10">
            <InfoRow icon={Film} label="品番">{work.product_code}</InfoRow>
            <InfoRow icon={UserRound} label="女優">{actressList.length ? <div className="flex flex-wrap gap-2">{actressList.map((actress) => <Link key={actress.id} className="inline-flex min-h-8 items-center rounded-full bg-white/[0.06] px-3 text-violet-200 transition hover:bg-violet-500/15 hover:text-white" href={`/actress/${encodeURIComponent(actress.name)}`}>{actress.name}</Link>)}</div> : work.series_name ? "複数出演者" : "情報なし"}</InfoRow>
            <InfoRow icon={Factory} label="メーカー">{work.makers ? <Link className="inline-flex min-h-8 items-center text-violet-300 hover:underline" href={`/maker/${encodeURIComponent(work.makers.name)}`}>{work.makers.name}</Link> : "情報なし"}</InfoRow>
            <InfoRow icon={PlayCircle} label="シリーズ">{work.series_name ? <Link className="inline-flex min-h-8 items-center text-violet-300 hover:underline" href={`/series/${encodeURIComponent(work.series_name)}`}>{work.series_name}</Link> : "シリーズなし"}</InfoRow>
            <InfoRow icon={CalendarDays} label="発売日">{work.release_date ?? "情報なし"}</InfoRow>
            <InfoRow icon={Tags} label="ジャンル">{work.genre ? <Link className="inline-flex min-h-8 items-center text-violet-300 hover:underline" href={`/genre/${encodeURIComponent(work.genre)}`}>{work.genre}</Link> : "情報なし"}</InfoRow>
            <InfoRow icon={Clock3} label="再生時間">{work.duration ? `${work.duration}分` : "情報なし"}</InfoRow>
            {work.source_name && <InfoRow icon={ExternalLink} label="情報出典">{work.source_name}</InfoRow>}
          </dl>
          {work.work_tags.length > 0 && <div className="mt-4 flex flex-wrap gap-2">{work.work_tags.flatMap(({ tags }) => tags ? [<Link key={tags.id} href={`/tag/${encodeURIComponent(tags.name)}`} className="rounded-full bg-slate-800 px-3 py-1.5 text-xs text-violet-200 hover:bg-violet-900">#{tags.name}</Link>] : [])}</div>}
          <div className="mt-5 grid gap-3">
            {salesLink && <a href={`/go/${encodeURIComponent(work.product_code)}?store=fanza&source=work_detail`} target="_blank" rel={salesLink.isAffiliate ? "sponsored noreferrer" : "noreferrer"} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-red-600 to-orange-500 px-4 font-bold text-white shadow-lg shadow-orange-950/20 transition hover:brightness-110 active:scale-[0.985]"><ExternalLink className="size-5" />FANZA正規販売ページへ</a>}
          </div>
        </aside>
      </article>

      {work.description && <section className="mt-10 rounded-2xl border border-slate-800 bg-slate-900/40 p-5 sm:p-7"><h2 className="mb-3 text-xl font-bold">作品詳細</h2><p className="whitespace-pre-wrap text-sm leading-7 text-slate-300">{work.description}</p></section>}
      <WorkSection title={`${actressList[0]?.name ?? "同じ出演者"}の出演作品`} description="気になる出演者の別作品へすぐ移動できます。" works={actressWorks} videoId={work.id} source="same_actress" />
      <WorkSection title="同じメーカーの作品" description={work.makers?.name ? `${work.makers.name}の作品を続けて見る` : undefined} works={makerWorks} videoId={work.id} source="same_maker" />
      <WorkSection title="同じシリーズの作品" description={work.series_name ? `${work.series_name}シリーズの作品` : undefined} works={seriesWorks} videoId={work.id} source="same_series" />
      <WorkSection title="関連作品" description="ジャンルや人気傾向が近い作品" works={relatedWorks} videoId={work.id} source="popular_related" />
      <RecentlyViewedCarousel className="mt-14 px-0 sm:px-0" />
    </main>
  );
}
