import Link from "next/link";
import { SourceAwareWorkGrid } from "@/components/source-aware-work-grid";
import type { SourceAwarePublicWork } from "@/lib/public-catalog/source-aware";

export function SourceAwarePaginatedWorkGrid({
  works,
  nextHref,
  className = "",
  emptyMessage = "作品が見つかりません。",
}: {
  works: readonly SourceAwarePublicWork[];
  nextHref: string | null;
  className?: string;
  emptyMessage?: string;
}) {
  if (!works.length) {
    return <p className={`${className} rounded-xl border border-dashed border-slate-700 py-16 text-center text-slate-500`}>{emptyMessage}</p>;
  }
  return (
    <div className={className}>
      <SourceAwareWorkGrid works={works} />
      {nextHref && (
        <div className="mt-8 flex justify-center">
          <Link
            href={nextHref}
            rel="next"
            className="inline-flex min-h-12 items-center rounded-full border border-white/10 bg-white/[0.06] px-6 text-sm font-bold text-slate-100 transition hover:bg-white/[0.1] active:scale-[0.985]"
          >
            次の作品を読み込む
          </Link>
        </div>
      )}
    </div>
  );
}
