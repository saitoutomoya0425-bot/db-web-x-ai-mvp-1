import "server-only";

import { isMyFansPublicEnabled } from "@/lib/myfans/public-feature";
import {
  composeSourceAwarePublicPage,
  type SourceAwareInterleaveIndex,
} from "@/lib/public-catalog/source-aware";
import {
  decodeSourceAwareCursor,
  encodeSourceAwareCursor,
  initialSourceAwareCursorState,
  sourceAwareContextHash,
  type SourceAwareCursorKind,
  type SourceAwareCursorState,
} from "@/lib/public-catalog/source-aware-cursor";
import { getCatalogWorks, type CatalogSort } from "@/lib/queries/catalog";
import { searchVideos, type SearchFilters, type SearchSort } from "@/lib/queries/public-works";
import { getMyFansPublicCatalogPage, searchMyFansPublicWorksPage } from "@/lib/queries/myfans-public";

const DEFAULT_PAGE_SIZE = 96;
const MAX_PAGE_SIZE = 96;

function cursorSecret() {
  const secret = process.env.SOURCE_AWARE_CURSOR_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new Error("SOURCE_AWARE_CURSOR_SECRET_NOT_CONFIGURED");
  return secret;
}

function boundedPageSize(value?: number) {
  return Math.min(Math.max(value ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

function readCursor(options: {
  cursor?: string;
  kind: SourceAwareCursorKind;
  contextHash: string;
  myFansUnavailable: boolean;
}) {
  if (!options.cursor) {
    return {
      state: initialSourceAwareCursorState({
        kind: options.kind,
        contextHash: options.contextHash,
        myFansExhausted: options.myFansUnavailable,
      }),
      invalidCursor: false,
    };
  }
  const state = decodeSourceAwareCursor(
    options.cursor,
    { kind: options.kind, contextHash: options.contextHash },
    cursorSecret(),
  );
  return state
    ? { state, invalidCursor: false }
    : { state: null, invalidCursor: true };
}

function makeResult(options: {
  state: SourceAwareCursorState;
  fanzaWorks: Awaited<ReturnType<typeof getCatalogWorks>>;
  myFansWorks: Awaited<ReturnType<typeof getMyFansPublicCatalogPage>>;
  pageSize: number;
  myFansEnabled: boolean;
  queryCount: number;
}) {
  const page = composeSourceAwarePublicPage({
    fanzaWorks: options.fanzaWorks,
    myFansWorks: options.myFansWorks,
    myFansEnabled: options.myFansEnabled,
    limit: options.pageSize,
    interleaveIndex: options.state.interleaveIndex,
  });
  const fanzaExhausted = options.state.fanzaExhausted
    || options.fanzaWorks.length === page.consumedFanza;
  const myFansExhausted = options.state.myFansExhausted
    || options.myFansWorks.length === page.consumedMyFans;
  const lastMyFans = page.works
    .slice()
    .reverse()
    .find((work) => work.source === "myfans");
  const nextState: SourceAwareCursorState = {
    ...options.state,
    fanzaOffset: options.state.fanzaOffset + page.consumedFanza,
    myFansAfter: lastMyFans?.source === "myfans" ? lastMyFans.externalPostId : options.state.myFansAfter,
    fanzaExhausted,
    myFansExhausted,
    interleaveIndex: page.nextInterleaveIndex as SourceAwareInterleaveIndex,
  };
  const hasMore = page.works.length > 0 && (!fanzaExhausted || !myFansExhausted);
  return {
    myFansEnabled: options.myFansEnabled,
    works: page.works,
    hasMore,
    nextCursor: hasMore ? encodeSourceAwareCursor(nextState, cursorSecret()) : null,
    invalidCursor: false,
    queryCount: options.queryCount,
  };
}

export async function getSourceAwareCatalogWorks(options: {
  limit?: number;
  cursor?: string;
  sort?: CatalogSort;
  genre?: string;
  maker?: string;
} = {}) {
  const pageSize = boundedPageSize(options.limit);
  const enabled = isMyFansPublicEnabled();
  const myFansUnavailable = !enabled || Boolean(options.genre || options.maker);
  const contextHash = sourceAwareContextHash(JSON.stringify({
    kind: "catalog",
    sort: options.sort ?? "popular",
    genre: options.genre ?? "",
    maker: options.maker ?? "",
    myFansEnabled: !myFansUnavailable,
  }));
  const cursor = readCursor({ cursor: options.cursor, kind: "catalog", contextHash, myFansUnavailable });
  if (!cursor.state) {
    return { myFansEnabled: enabled, works: [], hasMore: false, nextCursor: null, invalidCursor: true, queryCount: 0 };
  }
  const fetchLimit = pageSize + 1;
  const [fanzaWorks, myFansWorks] = await Promise.all([
    cursor.state.fanzaExhausted
      ? Promise.resolve([])
      : getCatalogWorks({
        limit: fetchLimit,
        offset: cursor.state.fanzaOffset,
        sort: options.sort,
        genre: options.genre,
        maker: options.maker,
      }),
    cursor.state.myFansExhausted
      ? Promise.resolve([])
      : getMyFansPublicCatalogPage({ limit: fetchLimit, after: cursor.state.myFansAfter }),
  ]);
  return makeResult({
    state: cursor.state,
    fanzaWorks,
    myFansWorks,
    pageSize,
    myFansEnabled: !myFansUnavailable,
    queryCount: Number(!cursor.state.fanzaExhausted) + Number(!cursor.state.myFansExhausted),
  });
}

export async function searchSourceAwarePublicWorks(
  query: string,
  options: {
    limit?: number;
    cursor?: string;
    sort?: SearchSort;
    filters?: SearchFilters;
  } = {},
) {
  const pageSize = boundedPageSize(options.limit);
  const sort = options.sort ?? "popular";
  const filters = options.filters ?? {};
  const enabled = isMyFansPublicEnabled();
  const hasFanzaOnlyFilter = Boolean(filters.actress || filters.maker || filters.series);
  const myFansUnavailable = !enabled || !query.trim() || hasFanzaOnlyFilter;
  const contextHash = sourceAwareContextHash(JSON.stringify({
    kind: "search",
    query: query.trim(),
    sort,
    actress: filters.actress ?? "",
    maker: filters.maker ?? "",
    series: filters.series ?? "",
    myFansEnabled: !myFansUnavailable,
  }));
  const cursor = readCursor({ cursor: options.cursor, kind: "search", contextHash, myFansUnavailable });
  if (!cursor.state) {
    return { myFansEnabled: enabled, works: [], hasMore: false, nextCursor: null, invalidCursor: true, queryCount: 0 };
  }
  const fetchLimit = pageSize + 1;
  const [fanzaWorks, myFansWorks] = await Promise.all([
    cursor.state.fanzaExhausted
      ? Promise.resolve([])
      : searchVideos(query, fetchLimit, cursor.state.fanzaOffset, sort, filters),
    cursor.state.myFansExhausted
      ? Promise.resolve([])
      : searchMyFansPublicWorksPage(query, { limit: fetchLimit, after: cursor.state.myFansAfter }),
  ]);
  return makeResult({
    state: cursor.state,
    fanzaWorks,
    myFansWorks,
    pageSize,
    myFansEnabled: !myFansUnavailable,
    queryCount: Number(!cursor.state.fanzaExhausted) + Number(!cursor.state.myFansExhausted),
  });
}
