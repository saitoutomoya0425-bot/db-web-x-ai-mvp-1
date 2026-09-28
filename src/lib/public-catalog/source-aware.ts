import type { WorkDetail } from "@/types/database";
import type { MyFansPublicWork } from "@/lib/myfans/public-ui";

export type FanzaPublicWork = {
  source: "fanza";
  sourceBadge: "FANZA";
  stableIdentity: string;
  detailHref: string;
  title: string;
  legacyWork: WorkDetail;
};

export type SourceAwarePublicWork = FanzaPublicWork | MyFansPublicWork;

export type SourceAwareInterleaveIndex = 0 | 1 | 2 | 3;

export function toFanzaPublicWork(work: WorkDetail): FanzaPublicWork {
  return {
    source: "fanza",
    sourceBadge: "FANZA",
    stableIdentity: `fanza:${work.product_code}`,
    detailHref: `/work/${encodeURIComponent(work.product_code)}`,
    title: work.title,
    legacyWork: work,
  };
}

export function composeSourceAwarePublicWorks(options: {
  fanzaWorks: readonly WorkDetail[];
  myFansWorks: readonly MyFansPublicWork[];
  myFansEnabled: boolean;
  limit?: number;
}) {
  const maximum = Math.max(options.limit ?? options.fanzaWorks.length + options.myFansWorks.length, 0);
  return composeSourceAwarePublicPage({
    ...options,
    limit: maximum,
    interleaveIndex: 0,
  }).works;
}

export function composeSourceAwarePublicPage(options: {
  fanzaWorks: readonly WorkDetail[];
  myFansWorks: readonly MyFansPublicWork[];
  myFansEnabled: boolean;
  limit: number;
  interleaveIndex?: SourceAwareInterleaveIndex;
}) {
  const fanza = options.fanzaWorks.map(toFanzaPublicWork);
  const maximum = Math.max(options.limit, 0);
  if (!options.myFansEnabled) {
    const works = fanza.slice(0, maximum);
    return {
      works,
      consumedFanza: works.length,
      consumedMyFans: 0,
      nextInterleaveIndex: (options.interleaveIndex ?? 0) as SourceAwareInterleaveIndex,
    };
  }

  const combined: SourceAwarePublicWork[] = [];
  let fanzaIndex = 0;
  let myFansIndex = 0;
  let interleaveIndex = options.interleaveIndex ?? 0;
  while (combined.length < maximum && (fanzaIndex < fanza.length || myFansIndex < options.myFansWorks.length)) {
    const wantsMyFans = interleaveIndex === 3;
    if (!wantsMyFans && fanzaIndex < fanza.length) {
      combined.push(fanza[fanzaIndex]);
      fanzaIndex += 1;
      interleaveIndex = ((interleaveIndex + 1) % 4) as SourceAwareInterleaveIndex;
    } else if (wantsMyFans && myFansIndex < options.myFansWorks.length) {
      combined.push(options.myFansWorks[myFansIndex]);
      myFansIndex += 1;
      interleaveIndex = 0;
    } else if (fanzaIndex < fanza.length) {
      combined.push(fanza[fanzaIndex]);
      fanzaIndex += 1;
    } else if (myFansIndex < options.myFansWorks.length) {
      combined.push(options.myFansWorks[myFansIndex]);
      myFansIndex += 1;
    }
  }
  return {
    works: combined,
    consumedFanza: fanzaIndex,
    consumedMyFans: myFansIndex,
    nextInterleaveIndex: interleaveIndex,
  };
}
