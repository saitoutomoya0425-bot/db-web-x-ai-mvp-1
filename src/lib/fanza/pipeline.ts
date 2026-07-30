import { createHash } from "node:crypto";
import { normalizeFanzaItem, type NormalizedFanzaProduct } from "./normalize.ts";

export type PreviewStatus = "new" | "update" | "unchanged" | "duplicate" | "needs_review";
export type ExistingProduct = {
  id: string;
  kind?: "video" | "source";
  externalProductId?: string | null;
  normalizedProductCode?: string | null;
  title?: string | null;
  actressNames?: string[];
  makerName?: string | null;
  seriesName?: string | null;
  genres?: string[];
  reviewStatus?: string | null;
  previewStatus?: PreviewStatus | null;
  attemptCount?: number;
  linkedVideoId?: string | null;
};
export type StagedProduct = {
  externalProductId: string;
  rawPayload: unknown;
  payloadHash: string;
  normalized: NormalizedFanzaProduct;
  previewStatus: PreviewStatus;
  duplicateVideoId: string | null;
  existingSourceProductId: string | null;
  existingReviewStatus: string | null;
  existingPreviewStatus: PreviewStatus | null;
  existingAttemptCount: number;
  reviewReasons: string[];
};
export type StageError = {
  index: number;
  externalProductId: string | null;
  originalProductCode: string | null;
  stage: "normalize" | "deduplicate";
  errorType: string;
  errorCode: string | null;
  message: string;
  rawPayload: unknown;
  retryable: boolean;
};
export type StageResult = {
  processed: number;
  staged: number;
  counts: Record<PreviewStatus, number>;
  errors: StageError[];
  products: StagedProduct[];
};

export interface ProductLookup {
  byExternalIds(ids: string[]): Promise<Map<string, ExistingProduct[]>>;
  byNormalizedCodes(codes: string[]): Promise<Map<string, ExistingProduct[]>>;
}

const comparable = (product: NormalizedFanzaProduct) => ({
  title: product.title,
  actressNames: product.actressNames,
  makerName: product.makerName,
  seriesName: product.seriesName,
  genres: product.genres,
});

export const FANZA_ALLOWED_DOMAINS = ["dmm.co.jp", "fanza.co.jp"] as const;

export function isAllowedFanzaUrl(value: string | null) {
  if (!value) return false;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return FANZA_ALLOWED_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

export function fanzaSafetyReviewReasons(product: NormalizedFanzaProduct) {
  const reasons: string[] = [];
  if (product.productCodeRejectionCode) reasons.push(product.productCodeRejectionCode);
  if (!product.externalProductId) reasons.push("external_product_id_missing");
  if (!product.productCode) reasons.push("product_code_missing");
  if (!product.normalizedProductCode) reasons.push("normalized_product_code_missing");
  if (!product.title) reasons.push("title_missing");
  if (product.actressNames.length === 0) reasons.push("actress_metadata_missing");
  if (!isAllowedFanzaUrl(product.officialUrl)) reasons.push("official_url_not_allowed");
  const imageUrls = [product.thumbnailUrl, ...product.sampleImages].filter((value): value is string => Boolean(value));
  if (imageUrls.some((value) => !isAllowedFanzaUrl(value))) reasons.push("image_url_not_allowed");
  if (product.affiliateUrl && !isAllowedFanzaUrl(product.affiliateUrl)) reasons.push("affiliate_url_not_allowed");
  return reasons;
}

function sameComparable(left: ExistingProduct, right: NormalizedFanzaProduct) {
  const existing = {
    title: left.title ?? null,
    actressNames: left.actressNames ?? [],
    makerName: left.makerName ?? null,
    seriesName: left.seriesName ?? null,
    genres: left.genres ?? [],
  };
  return JSON.stringify(existing) === JSON.stringify(comparable(right));
}

export async function stageFanzaItems(rawItems: unknown[], lookup: ProductLookup): Promise<StageResult> {
  const normalized = rawItems.map(normalizeFanzaItem);
  const externalIds = [...new Set(normalized.map((item) => item.externalProductId).filter(Boolean))];
  const normalizedCodes = [...new Set(normalized.map((item) => item.normalizedProductCode).filter((item): item is string => Boolean(item)))];
  const [byExternalId, byNormalizedCode] = await Promise.all([
    lookup.byExternalIds(externalIds),
    lookup.byNormalizedCodes(normalizedCodes),
  ]);
  const counts: Record<PreviewStatus, number> = {
    new: 0, update: 0, unchanged: 0, duplicate: 0, needs_review: 0,
  };
  const products: StagedProduct[] = [];
  const errors: StageResult["errors"] = [];
  const batchExternalIds = new Map<string, number[]>();
  const batchCodes = new Map<string, Set<string>>();
  normalized.forEach((item, index) => {
    if (item.externalProductId) {
      const indexes = batchExternalIds.get(item.externalProductId) ?? [];
      indexes.push(index);
      batchExternalIds.set(item.externalProductId, indexes);
    }
    if (item.normalizedProductCode && item.externalProductId) {
      const ids = batchCodes.get(item.normalizedProductCode) ?? new Set<string>();
      ids.add(item.externalProductId);
      batchCodes.set(item.normalizedProductCode, ids);
    }
  });
  const handledExternalIds = new Set<string>();

  normalized.forEach((item, index) => {
    try {
      const reviewReasons = fanzaSafetyReviewReasons(item);
      const sourceKey = item.externalProductId
        || `missing:${createHash("sha256").update(JSON.stringify(rawItems[index])).digest("hex")}`;
      if (handledExternalIds.has(sourceKey)) return;
      handledExternalIds.add(sourceKey);
      const externalMatches = byExternalId.get(item.externalProductId) ?? [];
      const codeMatches = item.normalizedProductCode ? byNormalizedCode.get(item.normalizedProductCode) ?? [] : [];
      const sourceExternalMatches = externalMatches.filter((match) => match.kind === "source");
      const videoExternalMatches = externalMatches.filter((match) => match.kind !== "source");
      const sourceCodeMatches = codeMatches.filter((match) => match.kind === "source" && match.externalProductId !== item.externalProductId);
      const videoCodeMatches = codeMatches.filter((match) => match.kind !== "source");
      const distinctVideoMatches = new Set([...videoExternalMatches, ...videoCodeMatches].map((match) => match.id));
      const existingSource = sourceExternalMatches.length === 1 ? sourceExternalMatches[0] : null;
      const batchExternalDuplicates = batchExternalIds.get(item.externalProductId)?.length ?? 0;
      const batchCodeExternalIds = item.normalizedProductCode ? batchCodes.get(item.normalizedProductCode) : null;
      let previewStatus: PreviewStatus = "new";
      if (reviewReasons.length) previewStatus = "needs_review";
      else if (batchExternalDuplicates > 1) {
        const hashes = new Set((batchExternalIds.get(item.externalProductId) ?? [])
          .map((candidateIndex) => createHash("sha256").update(JSON.stringify(rawItems[candidateIndex])).digest("hex")));
        previewStatus = hashes.size === 1
          ? (existingSource ? (sameComparable(existingSource, item) ? "unchanged" : "update") : "new")
          : "needs_review";
        if (previewStatus === "needs_review") reviewReasons.push("same_external_id_payload_conflict");
      } else if ((batchCodeExternalIds?.size ?? 0) > 1) {
        previewStatus = "needs_review";
        reviewReasons.push("normalized_code_batch_collision");
      } else if (sourceExternalMatches.length > 1 || videoExternalMatches.length > 1) {
        previewStatus = "needs_review";
        reviewReasons.push("external_id_match_ambiguous");
      }
      else if (existingSource) previewStatus = sameComparable(existingSource, item) ? "unchanged" : "update";
      else if (sourceCodeMatches.length > 0) {
        previewStatus = "needs_review";
        reviewReasons.push("normalized_code_source_collision");
      } else if (distinctVideoMatches.size > 1) {
        previewStatus = "needs_review";
        reviewReasons.push("video_match_ambiguous");
      }
      else if (videoExternalMatches.length === 1) previewStatus = sameComparable(videoExternalMatches[0], item) ? "unchanged" : "update";
      else if (videoCodeMatches.length > 1) {
        previewStatus = "needs_review";
        reviewReasons.push("video_code_match_ambiguous");
      }
      else if (videoCodeMatches.length === 1) previewStatus = sameComparable(videoCodeMatches[0], item) ? "unchanged" : "update";
      counts[previewStatus]++;
      const matchedVideoId = existingSource?.linkedVideoId
        ?? (videoExternalMatches.length === 1 ? videoExternalMatches[0].id : null)
        ?? (videoCodeMatches.length === 1 && sourceCodeMatches.length === 0 ? videoCodeMatches[0].id : null);
      products.push({
        externalProductId: sourceKey,
        rawPayload: rawItems[index],
        payloadHash: createHash("sha256").update(JSON.stringify(rawItems[index])).digest("hex"),
        normalized: item,
        previewStatus,
        duplicateVideoId: previewStatus === "needs_review" ? null : matchedVideoId,
        existingSourceProductId: existingSource?.id ?? null,
        existingReviewStatus: existingSource?.reviewStatus ?? null,
        existingPreviewStatus: existingSource?.previewStatus ?? null,
        existingAttemptCount: existingSource?.attemptCount ?? 0,
        reviewReasons: [...new Set(reviewReasons)],
      });
    } catch (error) {
      errors.push({
        index,
        externalProductId: item.externalProductId || null,
        originalProductCode: item.originalProductCode,
        stage: "normalize",
        errorType: "invalid_item",
        errorCode: null,
        message: error instanceof Error ? error.message : "正規化に失敗しました。",
        rawPayload: rawItems[index],
        retryable: false,
      });
    }
  });
  return { processed: rawItems.length, staged: products.length, counts, errors, products };
}

export type ImportCheckpoint = {
  offset: number;
  processed: number;
  staged: number;
  failed: number;
  completed: boolean;
};

export async function runFanzaBatch(options: {
  checkpoint: ImportCheckpoint;
  batchSize: number;
  maxItems: number;
  dryRun: boolean;
  fetchPage: (offset: number, limit: number) => Promise<{ rawItems: unknown[]; hasMore: boolean }>;
  lookup: ProductLookup;
  persist: (products: StagedProduct[]) => Promise<void>;
}): Promise<{ checkpoint: ImportCheckpoint; result: StageResult }> {
  const remaining = Math.max(0, options.maxItems - options.checkpoint.processed);
  const limit = Math.min(100, Math.max(1, options.batchSize), remaining);
  if (!limit) {
    const empty = await stageFanzaItems([], options.lookup);
    return { checkpoint: { ...options.checkpoint, completed: true }, result: empty };
  }
  const page = await options.fetchPage(options.checkpoint.offset, limit);
  const result = await stageFanzaItems(page.rawItems, options.lookup);
  if (!options.dryRun && result.products.length) await options.persist(result.products);
  const processed = options.checkpoint.processed + result.processed;
  return {
    checkpoint: {
      offset: options.checkpoint.offset + result.processed,
      processed,
      staged: options.checkpoint.staged + (options.dryRun ? 0 : result.staged),
      failed: options.checkpoint.failed + result.errors.length,
      completed: !page.hasMore || result.processed === 0 || processed >= options.maxItems,
    },
    result,
  };
}
