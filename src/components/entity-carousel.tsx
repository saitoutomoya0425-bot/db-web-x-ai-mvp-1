import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { HorizontalCarouselShell } from "@/components/horizontal-carousel-shell";
import type { MetricRank, RankingType } from "@/lib/queries/discovery";

const routeByType: Record<RankingType, string> = {
  actress: "actress",
  maker: "maker",
  series: "series",
};

export function EntityCarousel({
  eyebrow,
  title,
  description,
  type,
  items,
  actionHref,
  actionLabel = "すべて見る",
  className = "",
}: {
  eyebrow?: ReactNode;
  title: string;
  description?: string;
  type: RankingType;
  items: MetricRank[];
  actionHref?: string;
  actionLabel?: string;
  className?: string;
}) {
  if (!items.length) return null;
  const route = routeByType[type];
  return (
    <HorizontalCarouselShell
      eyebrow={eyebrow}
      title={title}
      description={description}
      action={actionHref ? <Link href={actionHref} className="inline-flex items-center gap-1 text-sm text-slate-400 transition hover:text-white">{actionLabel}<ArrowRight className="size-4" /></Link> : null}
      className={className}
    >
      {items.map((item) => (
        <Link
          key={`${type}-${item.key}`}
          href={`/${route}/${encodeURIComponent(item.key)}`}
          className="group flex h-[118px] w-[166px] shrink-0 snap-start flex-col justify-between rounded-2xl border border-white/5 bg-white/[0.035] p-4 shadow-sm shadow-black/10 transition duration-200 hover:-translate-y-0.5 hover:border-white/15 hover:bg-white/[0.06] active:scale-[0.985] sm:w-[210px]"
        >
          <div className="flex items-start justify-between gap-3">
            <span className="grid size-9 place-items-center rounded-full bg-white/90 text-xs font-black text-slate-950 shadow-lg">#{item.rank}</span>
            <span className="rounded-full border border-white/10 px-2 py-1 text-[10px] text-slate-400">{item.workCount.toLocaleString()}作品</span>
          </div>
          <div>
            <p className="line-clamp-2 text-base font-bold leading-5 text-slate-100">{item.key}</p>
            <p className="mt-1 text-xs text-slate-500">{item.searches.toLocaleString()} searches</p>
          </div>
        </Link>
      ))}
    </HorizontalCarouselShell>
  );
}
