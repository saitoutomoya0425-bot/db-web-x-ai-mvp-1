import { SourceAwarePublicWorkCard } from "@/components/source-aware-public-work-card";
import type { SourceAwarePublicWork } from "@/lib/public-catalog/source-aware";

export function SourceAwareWorkGrid({ works, className = "" }: { works: readonly SourceAwarePublicWork[]; className?: string }) {
  if (!works.length) return null;
  return (
    <div className={`grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 ${className}`}>
      {works.map((work) => <SourceAwarePublicWorkCard key={work.stableIdentity} work={work} />)}
    </div>
  );
}
