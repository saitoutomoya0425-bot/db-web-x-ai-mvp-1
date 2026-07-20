"use client";

import type { ReactNode } from "react";
import { useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

export function HorizontalCarouselShell({
  id,
  eyebrow,
  title,
  description,
  action,
  children,
  className = "",
}: {
  id?: string;
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const scrollBy = (direction: -1 | 1) => {
    const node = scrollerRef.current;
    if (!node) return;
    node.scrollBy({ left: direction * Math.min(node.clientWidth * 0.86, 760), behavior: "smooth" });
  };

  return (
    <section id={id} className={`mx-auto max-w-7xl px-4 sm:px-6 ${className}`}>
      <div className="mb-2 flex items-end justify-between gap-3 sm:mb-4">
        <div className="min-w-0">
          {eyebrow && <div className="mb-2 text-xs font-bold tracking-[0.18em] text-violet-300/80">{eyebrow}</div>}
          <h2 className="text-xl font-bold tracking-tight sm:text-2xl">{title}</h2>
          {description && <p className="mt-1.5 text-sm leading-6 text-slate-500">{description}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {action && <div className="hidden sm:flex">{action}</div>}
          <button type="button" onClick={() => scrollBy(-1)} className="hidden size-9 place-items-center rounded-full border border-white/10 bg-white/[0.05] text-slate-300 transition hover:bg-white/[0.09] active:scale-95 md:grid" aria-label="左へスクロール"><ChevronLeft className="size-5" /></button>
          <button type="button" onClick={() => scrollBy(1)} className="hidden size-9 place-items-center rounded-full border border-white/10 bg-white/[0.05] text-slate-300 transition hover:bg-white/[0.09] active:scale-95 md:grid" aria-label="右へスクロール"><ChevronRight className="size-5" /></button>
        </div>
      </div>
      <div className="relative overflow-hidden">
        <div ref={scrollerRef} className="-mx-4 snap-x snap-mandatory overflow-x-auto scroll-smooth overscroll-x-contain px-4 pb-2 [scrollbar-width:none] [-webkit-overflow-scrolling:touch] sm:-mx-6 sm:px-6 [&::-webkit-scrollbar]:hidden">
          <div className="flex w-max min-w-full flex-nowrap gap-3 pr-16 motion-safe:animate-[okazuCarouselNudge_900ms_ease-out_420ms_1_both] sm:gap-4 sm:pr-20">{children}</div>
        </div>
      </div>
      {action && <div className="mt-3 flex sm:hidden">{action}</div>}
    </section>
  );
}
