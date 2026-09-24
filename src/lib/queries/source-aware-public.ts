import "server-only";

import { isMyFansPublicEnabled } from "@/lib/myfans/public-feature";
import { composeSourceAwarePublicWorks } from "@/lib/public-catalog/source-aware";
import { getCatalogWorks, type CatalogSort } from "@/lib/queries/catalog";
import { searchVideos, type SearchFilters, type SearchSort } from "@/lib/queries/public-works";
import { getMyFansPublicCatalog, searchMyFansPublicWorks } from "@/lib/queries/myfans-public";

export async function getSourceAwareCatalogWorks(options: {
  limit?: number;
  offset?: number;
  sort?: CatalogSort;
  genre?: string;
  maker?: string;
} = {}) {
  const limit = Math.min(Math.max(options.limit ?? 24, 1), 1000);
  const enabled = isMyFansPublicEnabled();
  const [fanzaWorks, myFansWorks] = await Promise.all([
    getCatalogWorks(options),
    enabled && !options.genre && !options.maker
      ? getMyFansPublicCatalog({ limit, offset: options.offset })
      : Promise.resolve([]),
  ]);
  return {
    myFansEnabled: enabled,
    fanzaWorks,
    myFansWorks,
    works: composeSourceAwarePublicWorks({ fanzaWorks, myFansWorks, myFansEnabled: enabled, limit }),
  };
}
export async function searchSourceAwarePublicWorks(
  query: string,
  limit = 24,
  offset = 0,
  sort: SearchSort = "popular",
  filters: SearchFilters = {},
) {
  const enabled = isMyFansPublicEnabled();
  const hasFanzaOnlyFilter = Boolean(filters.actress || filters.maker || filters.series);
  const [fanzaWorks, myFansWorks] = await Promise.all([
    searchVideos(query, limit, offset, sort, filters),
    enabled && query.trim() && !hasFanzaOnlyFilter
      ? searchMyFansPublicWorks(query, { limit, offset })
      : Promise.resolve([]),
  ]);
  return {
    myFansEnabled: enabled,
    fanzaWorks,
    myFansWorks,
    works: composeSourceAwarePublicWorks({ fanzaWorks, myFansWorks, myFansEnabled: enabled, limit }),
  };
}
