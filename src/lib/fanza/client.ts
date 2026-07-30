import "server-only";
import { normalizeFanzaItem, type NormalizedFanzaProduct } from "@/lib/fanza/normalize";

const ENDPOINT = "https://api.dmm.com/affiliate/v3/ItemList";

type FetchResult = {
  rawItems: unknown[];
  normalized: NormalizedFanzaProduct[];
  request: { site: string; service: string; floor: string; hits: number; keyword: string | null };
  pagination: { offset: number; returned: number; total: number | null; hasMore: boolean };
};

const retryableStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function fanzaConfiguration() {
  const apiId = process.env.FANZA_API_ID?.trim() ?? "";
  const affiliateId = process.env.FANZA_AFFILIATE_ID?.trim() ?? "";
  return {
    configured: Boolean(apiId && affiliateId),
    apiId,
    affiliateId,
    site: process.env.FANZA_API_SITE?.trim() || "FANZA",
    service: process.env.FANZA_API_SERVICE?.trim() || "digital",
    floor: process.env.FANZA_API_FLOOR?.trim() || "videoa",
  };
}

export async function fetchFanzaProducts(options: {
  limit?: number;
  keyword?: string | null;
  offset?: number;
  maxRetries?: number;
} = {}): Promise<FetchResult> {
  const config = fanzaConfiguration();
  if (!config.configured) throw new Error("FANZA_API_CREDENTIALS_MISSING");
  const hits = Math.min(100, Math.max(1, options.limit ?? 10));
  const offset = Math.max(1, Math.floor(options.offset ?? 1));
  const maxRetries = Math.min(5, Math.max(0, Math.floor(options.maxRetries ?? 3)));
  const keyword = options.keyword?.trim().slice(0, 100) || null;
  const params = new URLSearchParams({
    api_id: config.apiId,
    affiliate_id: config.affiliateId,
    site: config.site,
    service: config.service,
    floor: config.floor,
    hits: String(hits),
    offset: String(offset),
    sort: "date",
    output: "json",
  });
  if (keyword) params.set("keyword", keyword);
  let response: Response | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      response = await fetch(`${ENDPOINT}?${params}`, {
        signal: AbortSignal.timeout(20_000),
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (response.ok || !retryableStatuses.has(response.status) || attempt === maxRetries) break;
    } catch (error) {
      if (attempt === maxRetries) throw error;
    }
    await wait(Math.min(8_000, 500 * 2 ** attempt + Math.floor(Math.random() * 250)));
  }
  if (!response) throw new Error("FANZA_API_NO_RESPONSE");
  if (!response.ok) throw new Error(`FANZA_API_HTTP_${response.status}`);
  const payload = await response.json() as {
    result?: {
      status?: number;
      message?: string;
      errors?: unknown;
      items?: unknown[];
      total_count?: number;
      result_count?: number;
    };
  };
  if (Number(payload.result?.status ?? 200) >= 400) {
    throw new Error(`FANZA_API_ERROR: ${payload.result?.message ?? "unknown"}`);
  }
  const rawItems = Array.isArray(payload.result?.items) ? payload.result.items.slice(0, hits) : [];
  const totalValue = Number(payload.result?.total_count);
  const total = Number.isFinite(totalValue) && totalValue >= 0 ? totalValue : null;
  const returned = rawItems.length;
  return {
    rawItems,
    normalized: rawItems.map(normalizeFanzaItem),
    request: { site: config.site, service: config.service, floor: config.floor, hits, keyword },
    pagination: {
      offset,
      returned,
      total,
      hasMore: returned === hits && (total === null || offset + returned - 1 < total),
    },
  };
}
