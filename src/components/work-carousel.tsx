"use client";

import type { ReactNode } from "react";
import { PublicWorkCard } from "@/components/public-work-card";
import { HorizontalCarouselShell } from "@/components/horizontal-carousel-shell";
import type { WorkDetail } from "@/types/database";

type RelatedTracking = { videoId: string; source: string };

export function WorkCarousel({
  eyebrow,
  title,
  description,
  action,
  works,
  rankOffset = 0,
  showRank = false,
  relatedTracking,
  className = "",
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  works: WorkDetail[];
  rankOffset?: number;
  showRank?: boolean;
  relatedTracking?: RelatedTracking;
  className?: string;
}) {
  if (!works.length) return null;
  return (
    <HorizontalCarouselShell eyebrow={eyebrow} title={title} description={description} action={action} className={className}>
      {works.map((work, index) => (
        <div key={work.id} className="w-[166px] shrink-0 snap-start sm:w-[216px] lg:w-[233px]">
          <PublicWorkCard work={work} compact rank={showRank ? rankOffset + index + 1 : undefined} count={"search_count" in work && typeof work.search_count === "number" ? work.search_count : undefined} relatedTracking={relatedTracking} />
        </div>
      ))}
    </HorizontalCarouselShell>
  );
}
