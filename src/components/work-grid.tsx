import { PublicWorkCard } from "@/components/public-work-card";
import type { WorkDetail } from "@/types/database";

export function WorkGrid({ works, className = "" }: { works: WorkDetail[]; className?: string }) {
  if (!works.length) return null;
  return (
    <div className={`grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 ${className}`}>
      {works.map((work) => <PublicWorkCard key={work.id} work={work} />)}
    </div>
  );
}
