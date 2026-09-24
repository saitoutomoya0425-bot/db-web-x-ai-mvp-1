"use client";

import Link from "next/link";
import { ImageOff } from "lucide-react";
import { PublicWorkCard } from "@/components/public-work-card";
import { currentListViewKey, writeListViewState } from "@/lib/list-view-state";
import { myFansMediaTypeLabel } from "@/lib/myfans/public-ui";
import type { SourceAwarePublicWork } from "@/lib/public-catalog/source-aware";

function priceLabel(priceJpy: number | null) {
  return priceJpy === null ? null : new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: 0,
  }).format(priceJpy);
}

export function SourceAwarePublicWorkCard({
  work,
  rank,
  count,
}: {
  work: SourceAwarePublicWork;
  rank?: number;
  count?: number;
}) {
  if (work.source === "fanza") {
    return <PublicWorkCard work={work.legacyWork} rank={rank} count={count} />;
  }
  const price = priceLabel(work.priceJpy);
  const mediaType = myFansMediaTypeLabel(work.mediaType);
  return (
    <Link
      href={work.detailHref}
      onClick={() => writeListViewState(currentListViewKey(), {
        scrollY: window.scrollY,
        selectedCode: work.stableIdentity,
      })}
      className="group block overflow-hidden rounded-2xl border border-white/5 bg-white/[0.035] shadow-sm shadow-black/10 transition duration-200 hover:-translate-y-0.5 hover:border-white/15 hover:bg-white/[0.06] active:scale-[0.985]"
      data-source="myfans"
    >
      <div className="relative grid aspect-[7/10] place-items-center overflow-hidden bg-slate-950/80 px-4 text-center sm:aspect-[3/4]">
        {rank && <span className="absolute left-2 top-2 grid size-5 place-items-center rounded-full bg-white/90 text-[9px] font-bold text-slate-950 shadow-lg">#{rank}</span>}
        <div className="text-slate-600">
          <ImageOff aria-hidden="true" className="mx-auto size-10" />
          <p className="mt-3 text-xs">{work.placeholder.label}</p>
        </div>
      </div>
      <div className="space-y-2 p-3.5">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex rounded-full border border-violet-400/20 bg-violet-400/10 px-2 py-1 text-[10px] font-bold text-violet-200">{work.sourceBadge}</span>
          {price && <span className="text-xs font-medium text-slate-300">{price}</span>}
        </div>
        <h3 className="line-clamp-2 min-h-11 text-sm font-semibold leading-5 text-slate-100">{work.title}</h3>
        <div className="space-y-1 text-xs leading-4 text-slate-400">
          <p className="truncate font-medium text-slate-300"><span className="mr-1 text-slate-500">クリエイター</span>{work.creatorName}</p>
          {mediaType && <p className="text-slate-500"><span className="mr-1 text-slate-600">形式</span>{mediaType}</p>}
          {typeof count === "number" && <p className="text-slate-500">{count}</p>}
        </div>
      </div>
    </Link>
  );
}
