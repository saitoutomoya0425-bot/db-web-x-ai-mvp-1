export const FANZA_SITEMAP_PAGE_SIZE = 1_000;
export const MYFANS_SITEMAP_PAGE_SIZE = 1_000;

export type PublicSitemapPlan = {
  fanzaPages: number;
  myFansPages: number;
  entries: string[];
};

function pageCount(count: number, pageSize: number, minimum = 0) {
  const normalized = Number.isSafeInteger(count) && count > 0 ? count : 0;
  return Math.max(minimum, Math.ceil(normalized / pageSize));
}

export function createPublicSitemapPlan(options: {
  site: string;
  fanzaCount: number;
  myFansCount: number;
}): PublicSitemapPlan {
  const site = options.site.replace(/\/$/, "");
  const fanzaPages = pageCount(options.fanzaCount, FANZA_SITEMAP_PAGE_SIZE, 1);
  const myFansPages = pageCount(options.myFansCount, MYFANS_SITEMAP_PAGE_SIZE);
  return {
    fanzaPages,
    myFansPages,
    entries: [
      `${site}/sitemaps/entities.xml`,
      ...Array.from({ length: fanzaPages }, (_, page) => `${site}/sitemaps/${page}.xml`),
      ...Array.from({ length: myFansPages }, (_, page) => `${site}/sitemaps/myfans/${page}.xml`),
    ],
  };
}

export function sliceSitemapFixture<T>(rows: readonly T[], page: number, pageSize: number) {
  if (!Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger(pageSize) || pageSize < 1) return [];
  const start = page * pageSize;
  return rows.slice(start, start + pageSize);
}
