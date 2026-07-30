import postgres from "postgres";
import { stageFanzaItems } from "../src/lib/fanza/pipeline.ts";

const required = ["SUPABASE_DB_URL", "FANZA_API_ID", "FANZA_AFFILIATE_ID"];
for (const key of required) {
  if (!process.env[key]?.trim()) throw new Error(`${key} is required`);
}

const apiId = process.env.FANZA_API_ID.trim();
const affiliateId = process.env.FANZA_AFFILIATE_ID.trim();
const limit = Math.min(10, Math.max(1, Number(process.argv[2] ?? 10)));
const sql = postgres(process.env.SUPABASE_DB_URL, {
  ssl: "require",
  max: 1,
  prepare: false,
  connect_timeout: 20,
  idle_timeout: 20,
});

const normalizeCode = (value) =>
  typeof value === "string" ? value.toUpperCase().replace(/[^A-Z0-9]/g, "") : null;

const snapshot = async () => {
  const [videos] = await sql`
    select count(*)::integer as count,
      count(*) filter (where is_published)::integer as published,
      md5(coalesce(jsonb_agg(to_jsonb(v) order by id)::text, '[]')) as digest
    from public.videos v
  `;
  const [sources] = await sql`
    select count(*)::integer as count,
      md5(coalesce(jsonb_agg(to_jsonb(s) order by id)::text, '[]')) as digest
    from public.source_products s
  `;
  const [jobs] = await sql`select count(*)::integer as count from public.fanza_import_jobs`;
  const [errors] = await sql`select count(*)::integer as count from public.fanza_import_errors`;
  return { videos, sources, jobs: jobs.count, errors: errors.count };
};

const before = await snapshot();

try {
  const params = new URLSearchParams({
    api_id: apiId,
    affiliate_id: affiliateId,
    site: process.env.FANZA_API_SITE?.trim() || "FANZA",
    service: process.env.FANZA_API_SERVICE?.trim() || "digital",
    floor: process.env.FANZA_API_FLOOR?.trim() || "videoa",
    hits: String(limit),
    offset: "1",
    sort: "date",
    output: "json",
  });
  const response = await fetch(`https://api.dmm.com/affiliate/v3/ItemList?${params}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`FANZA_API_HTTP_${response.status}`);
  const payload = await response.json();
  if (Number(payload?.result?.status ?? 200) >= 400) {
    throw new Error(`FANZA_API_RESPONSE_${Number(payload?.result?.status) || "ERROR"}`);
  }
  const rawItems = Array.isArray(payload?.result?.items)
    ? payload.result.items.slice(0, limit)
    : [];

  const videos = await sql`
    select id, product_code, title, actress_name, maker_name, series_name, genre,
      external_product_id
    from public.videos
  `;
  const sources = await sql`
    select id, external_product_id, normalized_product_code, normalized_data,
      review_status, preview_status, attempt_count, promoted_video_id, duplicate_video_id
    from public.source_products
  `;
  const videoRows = videos.map((video) => ({
    id: video.id,
    kind: "video",
    externalProductId: video.external_product_id,
    normalizedProductCode: normalizeCode(video.product_code),
    title: video.title,
    actressNames: video.actress_name ? [video.actress_name] : [],
    makerName: video.maker_name,
    seriesName: video.series_name,
    genres: video.genre ? [video.genre] : [],
  }));
  const sourceRows = sources.map((source) => ({
    id: source.id,
    kind: "source",
    externalProductId: source.external_product_id,
    normalizedProductCode: source.normalized_product_code,
    title: source.normalized_data?.title ?? null,
    actressNames: source.normalized_data?.actressNames ?? [],
    makerName: source.normalized_data?.makerName ?? null,
    seriesName: source.normalized_data?.seriesName ?? null,
    genres: source.normalized_data?.genres ?? [],
    reviewStatus: source.review_status,
    previewStatus: source.preview_status,
    attemptCount: source.attempt_count,
    linkedVideoId: source.promoted_video_id ?? source.duplicate_video_id,
  }));
  const allRows = [...videoRows, ...sourceRows];
  const lookup = {
    async byExternalIds(ids) {
      return new Map(ids.map((id) => [
        id,
        allRows.filter((row) => row.externalProductId === id),
      ]));
    },
    async byNormalizedCodes(codes) {
      return new Map(codes.map((code) => [
        code,
        allRows.filter((row) => row.normalizedProductCode === code),
      ]));
    },
  };

  const staged = await stageFanzaItems(rawItems, lookup);
  const hostOf = (value) => {
    try { return value ? new URL(value).hostname.toLowerCase() : null; } catch { return null; }
  };
  const officialHosts = staged.products.map((item) => hostOf(item.normalized.officialUrl));
  const imageHosts = staged.products.flatMap((item) => [
    hostOf(item.normalized.thumbnailUrl),
    ...item.normalized.sampleImages.map(hostOf),
  ]).filter(Boolean);
  const affiliateHosts = staged.products.map((item) => hostOf(item.normalized.affiliateUrl));
  const safeSerialized = JSON.stringify({
    request_count: rawItems.length,
    products: staged.products.map((item) => ({
      external_product_id_present: Boolean(item.externalProductId),
      product_code_present: Boolean(item.normalized.productCode),
      normalized_code_present: Boolean(item.normalized.normalizedProductCode),
      preview_status: item.previewStatus,
    })),
  });
  if (safeSerialized.includes(apiId) || safeSerialized.includes(affiliateId)) {
    throw new Error("SECRET_LEAK_DETECTED");
  }

  const after = await snapshot();
  const unchanged = {
    videos: before.videos.count === after.videos.count
      && before.videos.digest === after.videos.digest,
    source_products: before.sources.count === after.sources.count
      && before.sources.digest === after.sources.digest,
    jobs: before.jobs === after.jobs,
    errors: before.errors === after.errors,
  };
  const allUnchanged = Object.values(unchanged).every(Boolean);
  const isOfficialHost = (host) => Boolean(host && [
    "dmm.co.jp", "fanza.co.jp",
  ].some((domain) => host === domain || host.endsWith(`.${domain}`)));
  const officialUrlsValid = officialHosts.every(isOfficialHost);
  const affiliateUrlsValid = affiliateHosts.every(isOfficialHost);
  const imageUrlsOfficial = imageHosts.every(isOfficialHost);
  const identifiersComplete = staged.products.every((item) =>
    Boolean(item.externalProductId && item.normalized.productCode && item.normalized.normalizedProductCode));

  const report = {
    api_authenticated: true,
    requested_limit: limit,
    received_count: rawItems.length,
    received_within_limit: rawItems.length <= limit,
    identifiers_complete: identifiersComplete,
    official_urls_valid: officialUrlsValid,
    official_urls_present: officialHosts.filter(Boolean).length,
    affiliate_urls_valid: affiliateUrlsValid,
    affiliate_urls_present: affiliateHosts.filter(Boolean).length,
    affiliate_url_hosts: [...new Set(affiliateHosts.filter(Boolean))],
    image_urls_official: imageUrlsOfficial,
    products_with_thumbnail: staged.products.filter((item) => item.normalized.thumbnailUrl).length,
    products_with_sample_images: staged.products.filter((item) => item.normalized.sampleImages.length).length,
    products_with_sample_video: staged.products.filter((item) => item.normalized.sampleVideoUrl).length,
    classifications: staged.counts,
    item_errors: staged.errors.length,
    database_unchanged: unchanged,
    videos_before_after: [before.videos.count, after.videos.count],
    published_before_after: [before.videos.published, after.videos.published],
    source_products_before_after: [before.sources.count, after.sources.count],
    secrets_exposed: false,
  };
  console.log(JSON.stringify(report, null, 2));

  if (
    rawItems.length === 0
    || rawItems.length > limit
    || !identifiersComplete
    || !officialUrlsValid
    || !affiliateUrlsValid
    || !imageUrlsOfficial
    || staged.errors.length > 0
    || !allUnchanged
  ) {
    process.exitCode = 1;
  }
} finally {
  await sql.end();
}
