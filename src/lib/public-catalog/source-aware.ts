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
  const fanza = options.fanzaWorks.map(toFanzaPublicWork);
  const maximum = Math.max(options.limit ?? fanza.length + options.myFansWorks.length, 0);
  if (!options.myFansEnabled || !options.myFansWorks.length) return fanza.slice(0, maximum);

  const combined: SourceAwarePublicWork[] = [];
  let fanzaIndex = 0;
  let myFansIndex = 0;
  while (combined.length < maximum && (fanzaIndex < fanza.length || myFansIndex < options.myFansWorks.length)) {
    for (let index = 0; index < 3 && fanzaIndex < fanza.length && combined.length < maximum; index += 1) {
      combined.push(fanza[fanzaIndex]);
      fanzaIndex += 1;
    }
    if (myFansIndex < options.myFansWorks.length && combined.length < maximum) {
      combined.push(options.myFansWorks[myFansIndex]);
      myFansIndex += 1;
    }
  }
  return combined;
}
