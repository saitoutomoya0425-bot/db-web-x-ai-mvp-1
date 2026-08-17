import { createHash } from "node:crypto";

export type FanzaFrontierRecordIdentity = {
  external_product_id: string;
  payload_hash: string;
};

export type FanzaFrontierAnchor = FanzaFrontierRecordIdentity & {
  normalized_product_code: string | null;
  release_date: string | null;
  previous_source_offset: number;
  previous_position: number;
};

export type FanzaLiveFrontierItem<T = unknown> = {
  externalProductId: string;
  payloadHash: string;
  payload: T;
};

export type FanzaAnchoredItem<T = unknown> = FanzaLiveFrontierItem<T> & {
  liveOffset: number;
};

export type FanzaAnchorDiscoveryResult<T = unknown> = {
  anchor: {
    externalProductId: string;
    previousOffset: number;
    liveOffset: number;
    drift: number;
  };
  anchorMatches: number;
  anchorPayloadMatches: number;
  anchorPageRequests: number;
  windowPageRequests: number;
  skippedPreviousIds: number;
  skippedWindowDuplicates: number;
  records: FanzaAnchoredItem<T>[];
};

type DiscoverOptions<T> = {
  anchors: FanzaFrontierAnchor[];
  deepestAnchorExternalId: string;
  parentExternalIds: ReadonlySet<string>;
  searchStartOffset: number;
  pageSize: number;
  maxAnchorPages: number;
  minAnchorMatches: number;
  windowSize: number;
  maxWindowPages: number;
  fetchPage: (offset: number, pageSize: number) => Promise<FanzaLiveFrontierItem<T>[]>;
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function identityLines(records: readonly FanzaFrontierRecordIdentity[]) {
  return records.map((record) => `${record.external_product_id}\n`).join("");
}

function payloadIdentityLines(records: readonly FanzaFrontierRecordIdentity[]) {
  return records.map((record) => `${record.external_product_id}\t${record.payload_hash}\n`).join("");
}

export function fanzaFrontierMembershipSha256(records: readonly FanzaFrontierRecordIdentity[]) {
  return sha256(identityLines(records));
}

export function fanzaFrontierPayloadMembershipSha256(records: readonly FanzaFrontierRecordIdentity[]) {
  return sha256(payloadIdentityLines(records));
}

export function buildFanzaFrontierAnchors(
  records: ReadonlyArray<FanzaFrontierRecordIdentity & {
    normalized_product_code?: string | null;
    release_date?: string | null;
    source_offset: number;
  }>,
  count = 25,
): FanzaFrontierAnchor[] {
  if (!Number.isInteger(count) || count < 1) throw new Error("FANZA_ANCHOR_COUNT_INVALID");
  if (records.length < count) throw new Error("FANZA_PARENT_TOO_SMALL_FOR_ANCHORS");
  return records.slice(-count).map((record, index) => ({
    external_product_id: record.external_product_id,
    normalized_product_code: record.normalized_product_code ?? null,
    release_date: record.release_date ?? null,
    payload_hash: record.payload_hash,
    previous_source_offset: record.source_offset,
    previous_position: records.length - count + index + 1,
  }));
}

function positiveInteger(value: number, code: string) {
  if (!Number.isInteger(value) || value < 1) throw new Error(code);
}

export async function discoverAndCollectFanzaFrontier<T>(
  options: DiscoverOptions<T>,
): Promise<FanzaAnchorDiscoveryResult<T>> {
  positiveInteger(options.searchStartOffset, "FANZA_SEARCH_START_INVALID");
  positiveInteger(options.pageSize, "FANZA_PAGE_SIZE_INVALID");
  positiveInteger(options.maxAnchorPages, "FANZA_MAX_ANCHOR_PAGES_INVALID");
  positiveInteger(options.minAnchorMatches, "FANZA_MIN_ANCHOR_MATCHES_INVALID");
  positiveInteger(options.windowSize, "FANZA_WINDOW_SIZE_INVALID");
  positiveInteger(options.maxWindowPages, "FANZA_MAX_WINDOW_PAGES_INVALID");
  if (options.pageSize > 100) throw new Error("FANZA_PAGE_SIZE_MAX_100");
  if (options.minAnchorMatches > options.anchors.length) throw new Error("FANZA_MIN_ANCHORS_UNREACHABLE");

  const anchorsById = new Map(options.anchors.map((anchor) => [anchor.external_product_id, anchor]));
  if (anchorsById.size !== options.anchors.length) throw new Error("PHASE5D_ANCHOR_AMBIGUOUS");
  const deepest = anchorsById.get(options.deepestAnchorExternalId);
  if (!deepest) throw new Error("FANZA_DEEPEST_ANCHOR_NOT_IN_SET");

  const pages = new Map<number, FanzaLiveFrontierItem<T>[]>();
  const anchorPositions = new Map<string, number>();
  let anchorPageRequests = 0;
  let windowPageRequests = 0;

  const fetchAt = async (offset: number, phase: "anchor" | "window") => {
    const cached = pages.get(offset);
    if (cached) return cached;
    const page = await options.fetchPage(offset, options.pageSize);
    pages.set(offset, page);
    if (phase === "anchor") anchorPageRequests++;
    else windowPageRequests++;
    return page;
  };

  const observeAnchors = (page: readonly FanzaLiveFrontierItem<T>[], offset: number) => {
    for (const [index, item] of page.entries()) {
      if (!anchorsById.has(item.externalProductId)) continue;
      const liveOffset = offset + index;
      if (anchorPositions.has(item.externalProductId)) throw new Error("PHASE5D_ANCHOR_AMBIGUOUS");
      anchorPositions.set(item.externalProductId, liveOffset);
    }
    const matches = options.anchors
      .filter((anchor) => anchorPositions.has(anchor.external_product_id))
      .map((anchor) => ({
        previousPosition: anchor.previous_position,
        liveOffset: anchorPositions.get(anchor.external_product_id)!,
      }));
    for (let index = 1; index < matches.length; index++) {
      if (matches[index - 1].previousPosition >= matches[index].previousPosition
        || matches[index - 1].liveOffset >= matches[index].liveOffset) {
        throw new Error("PHASE5D_ANCHOR_AMBIGUOUS");
      }
    }
  };

  let deepestLiveOffset: number | null = null;
  let deepestPageOffset: number | null = null;
  let deepestObserved = false;
  for (let pageIndex = 0; pageIndex < options.maxAnchorPages; pageIndex++) {
    const offset = options.searchStartOffset + pageIndex * options.pageSize;
    const page = await fetchAt(offset, "anchor");
    observeAnchors(page, offset);
    const found = anchorPositions.get(options.deepestAnchorExternalId);
    if (found !== undefined) deepestObserved = true;
    if (found !== undefined && anchorPositions.size >= options.minAnchorMatches) {
      deepestLiveOffset = found;
      deepestPageOffset = offset;
      break;
    }
    if (page.length < options.pageSize) break;
  }
  if (deepestLiveOffset === null || deepestPageOffset === null) {
    throw new Error(deepestObserved ? "PHASE5D_ANCHOR_AMBIGUOUS" : "PHASE5D_ANCHOR_NOT_FOUND");
  }

  const records: FanzaAnchoredItem<T>[] = [];
  const collectedIds = new Set<string>();
  let skippedPreviousIds = 0;
  let skippedWindowDuplicates = 0;
  let reachedDeepest = false;
  const deepestPageIndex = Math.floor((deepestPageOffset - options.searchStartOffset) / options.pageSize);
  for (let relativePage = 0; relativePage < options.maxWindowPages && records.length < options.windowSize; relativePage++) {
    const pageIndex = deepestPageIndex + relativePage;
    const offset = options.searchStartOffset + pageIndex * options.pageSize;
    const page = await fetchAt(offset, "window");
    if (relativePage > 0) observeAnchors(page, offset);
    for (const [index, item] of page.entries()) {
      const liveOffset = offset + index;
      if (!reachedDeepest) {
        if (liveOffset === deepestLiveOffset && item.externalProductId === options.deepestAnchorExternalId) {
          reachedDeepest = true;
        }
        continue;
      }
      if (item.externalProductId === options.deepestAnchorExternalId) continue;
      if (options.parentExternalIds.has(item.externalProductId)) {
        skippedPreviousIds++;
        continue;
      }
      if (collectedIds.has(item.externalProductId)) {
        skippedWindowDuplicates++;
        continue;
      }
      collectedIds.add(item.externalProductId);
      records.push({ ...item, liveOffset });
      if (records.length === options.windowSize) break;
    }
    if (page.length < options.pageSize) break;
  }
  if (!reachedDeepest) throw new Error("PHASE5D_ANCHOR_AMBIGUOUS");
  if (records.length !== options.windowSize) throw new Error("PHASE5D_WINDOW_INCOMPLETE");

  const anchorPayloadMatches = options.anchors.filter((anchor) => {
    const position = anchorPositions.get(anchor.external_product_id);
    if (position === undefined) return false;
    const pageOffset = options.searchStartOffset
      + Math.floor((position - options.searchStartOffset) / options.pageSize) * options.pageSize;
    const page = pages.get(pageOffset) ?? [];
    return page[position - pageOffset]?.payloadHash === anchor.payload_hash;
  }).length;

  return {
    anchor: {
      externalProductId: deepest.external_product_id,
      previousOffset: deepest.previous_source_offset,
      liveOffset: deepestLiveOffset,
      drift: deepestLiveOffset - deepest.previous_source_offset,
    },
    anchorMatches: anchorPositions.size,
    anchorPayloadMatches,
    anchorPageRequests,
    windowPageRequests,
    skippedPreviousIds,
    skippedWindowDuplicates,
    records,
  };
}
