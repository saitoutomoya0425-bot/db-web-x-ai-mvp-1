"use client";

import Link from "next/link";
import { ResolvedThumbnail } from "@/components/resolved-thumbnail";
import { getLegacyRuntimeThumbnailOverride } from "@/lib/fanza/media";
import { currentListViewKey, writeListViewState } from "@/lib/list-view-state";
import { resolveThumbnailPresentation } from "@/lib/thumbnail/presentation";
import type { WorkDetail } from "@/types/database";

type RelatedTracking = { videoId: string; source: string };
export type PublicWorkCardItem = Pick<WorkDetail, "product_code" | "title"> & Partial<Pick<WorkDetail, "id" | "card_thumbnail_url" | "thumbnail_url" | "series_name" | "actresses" | "actress_list" | "makers">>;

export function PublicWorkCard({ work, rank, count, relatedTracking }: { work: PublicWorkCardItem; rank?: number; count?: number; relatedTracking?: RelatedTracking; compact?: boolean }) {
  const thumbnail = resolveThumbnailPresentation({
    code: work.product_code,
    legacy_runtime_override: getLegacyRuntimeThumbnailOverride(work.product_code),
    legacy_card_url: work.card_thumbnail_url,
    legacy_thumbnail_url: work.thumbnail_url,
  });
  const actressLabel = work.actress_list?.length
    ? `${work.actress_list[0]?.name}${work.actress_list.length > 1 ? ` ほか${work.actress_list.length - 1}名` : ""}`
    : work.actresses?.name ?? (work.series_name ? "複数出演者" : "出演者情報なし");
  const trackRelatedClick = () => {
    writeListViewState(currentListViewKey(), { scrollY: window.scrollY, selectedCode: work.product_code });
    if (!relatedTracking || !work.id) return;
    void fetch("/api/analytics/related-click", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        videoId: relatedTracking.videoId,
        relatedVideoId: work.id,
        source: relatedTracking.source,
        referrer: window.location.href,
      }),
      keepalive: true,
    }).catch(() => undefined);
  };
  return (
    <Link onClick={trackRelatedClick} href={`/work/${encodeURIComponent(work.product_code)}`} className="group block overflow-hidden rounded-2xl border border-white/5 bg-white/[0.035] shadow-sm shadow-black/10 transition duration-200 hover:-translate-y-0.5 hover:border-white/15 hover:bg-white/[0.06] active:scale-[0.985]">
      <ResolvedThumbnail
        resolution={thumbnail}
        alt={work.title}
        sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 18vw"
        className="relative aspect-[7/10] overflow-hidden bg-slate-900/80 sm:aspect-[3/4]"
        imageClassName="object-center opacity-0 transition duration-500 group-hover:scale-[1.025] animate-[okazuImageIn_.35s_ease-out_forwards]"
      >
        {rank && <span className="absolute left-2 top-2 grid size-5 place-items-center rounded-full bg-white/90 text-[9px] font-bold text-slate-950 shadow-lg">#{rank}</span>}
      </ResolvedThumbnail>
      <div className="space-y-2 p-3.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-violet-300/80">{work.product_code}</span>
        <h3 className="line-clamp-2 min-h-11 text-sm font-semibold leading-5 text-slate-100">{work.title}</h3>
        <div className="space-y-1 text-xs leading-4 text-slate-400">
          <div className="flex justify-between gap-2"><span className="min-w-0 truncate font-medium text-slate-300"><span className="mr-1 text-slate-500">女優</span>{actressLabel}</span>{typeof count === "number" && <span className="shrink-0 text-slate-500">{count}</span>}</div>
          <p className="truncate text-slate-500"><span className="mr-1 text-slate-600">メーカー</span>{work.makers?.name ?? "情報なし"}</p>
        </div>
      </div>
    </Link>
  );
}
