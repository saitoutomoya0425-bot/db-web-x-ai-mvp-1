"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { WorkGrid } from "@/components/work-grid";
import { currentListViewKey, readListViewState, writeListViewState } from "@/lib/list-view-state";
import type { WorkDetail } from "@/types/database";

const INITIAL_COUNT = 24;
const STEP_COUNT = 24;

export function LoadMoreWorkGrid({
  works,
  className = "",
  emptyMessage = "作品が見つかりません。",
}: {
  works: WorkDetail[];
  className?: string;
  emptyMessage?: string;
}) {
  const [visibleCount, setVisibleCount] = useState(INITIAL_COUNT);
  const listKey = currentListViewKey();
  const didRestore = useRef(false);
  const visibleCountRef = useRef(visibleCount);
  const visibleWorks = useMemo(() => works.slice(0, visibleCount), [works, visibleCount]);
  const hasMore = visibleCount < works.length;

  useEffect(() => {
    visibleCountRef.current = visibleCount;
  }, [visibleCount]);

  useEffect(() => {
    const state = readListViewState(listKey);
    const restoredCount = Math.min(Math.max(state?.visibleCount ?? INITIAL_COUNT, INITIAL_COUNT), works.length);
    setVisibleCount(restoredCount);
    didRestore.current = true;
    if (typeof state?.scrollY === "number") {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => window.scrollTo({ top: state.scrollY, behavior: "auto" }));
      });
    }
  }, [listKey, works.length]);

  useEffect(() => {
    if (!didRestore.current) return;
    writeListViewState(listKey, { visibleCount });
  }, [listKey, visibleCount]);

  useEffect(() => {
    if (!didRestore.current) return;
    let frame = 0;
    const save = () => writeListViewState(listKey, { visibleCount: visibleCountRef.current, scrollY: window.scrollY });
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        save();
      });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") save();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", save);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      save();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", save);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [listKey]);

  if (!works.length) {
    return <p className={`${className} rounded-xl border border-dashed border-slate-700 py-16 text-center text-slate-500`}>{emptyMessage}</p>;
  }

  return (
    <div className={className}>
      <WorkGrid works={visibleWorks} />
      {hasMore && (
        <div className="mt-8 flex justify-center">
          <button
            type="button"
            onClick={() => setVisibleCount((count) => {
              const next = Math.min(count + STEP_COUNT, works.length);
              writeListViewState(listKey, { visibleCount: next, scrollY: window.scrollY });
              return next;
            })}
            className="min-h-12 rounded-full border border-white/10 bg-white/[0.06] px-6 text-sm font-bold text-slate-100 transition hover:bg-white/[0.1] active:scale-[0.985]"
          >
            もっと読み込む
          </button>
        </div>
      )}
    </div>
  );
}
