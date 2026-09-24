"use client";

import type { ReactNode } from "react";
import { HorizontalCarouselShell } from "@/components/horizontal-carousel-shell";
import { SourceAwarePublicWorkCard } from "@/components/source-aware-public-work-card";
import type { SourceAwarePublicWork } from "@/lib/public-catalog/source-aware";

export function SourceAwareWorkCarousel({
  eyebrow,
  title,
  action,
  works,
  className = "",
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  action?: ReactNode;
  works: readonly SourceAwarePublicWork[];
  className?: string;
}) {
  if (!works.length) return null;
  return (
    <HorizontalCarouselShell eyebrow={eyebrow} title={title} action={action} className={className}>
      {works.map((work) => (
        <div key={work.stableIdentity} className="w-[166px] shrink-0 snap-start sm:w-[216px] lg:w-[233px]">
          <SourceAwarePublicWorkCard work={work} />
        </div>
      ))}
    </HorizontalCarouselShell>
  );
}
