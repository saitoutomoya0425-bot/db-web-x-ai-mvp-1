import postgres from "postgres";
import { normalizeFanzaItem } from "../src/lib/fanza/normalize.ts";
import { stageFanzaItems } from "../src/lib/fanza/pipeline.ts";

const TOTAL = Math.min(1_000, Math.max(1, Number(process.argv[2] ?? 100)));
const PAGE_SIZE = TOTAL > 100 ? 100 : Math.min(10, TOTAL);
const MAX_RETRIES = 3;
const startedAt = performance.now();
const memoryBefore = process.memoryUsage().heapUsed;
for (const key of ["SUPABASE_DB_URL", "FANZA_API_ID", "FANZA_AFFILIATE_ID"]) {
  if (!process.env[key]?.trim()) throw new Error(`${key} is required`);
}

const secretValues = [
  process.env.FANZA_API_ID.trim(),
  process.env.FANZA_AFFILIATE_ID.trim(),
  process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
].filter(Boolean);
const sql = postgres(process.env.SUPABASE_DB_URL, {
  ssl: "require",
  max: 1,
  prepare: false,
  connect_timeout: 20,
  idle_timeout: 20,
});
const normalizeCode = (value) =>
  typeof value === "string" ? value.toUpperCase().replace(/[^A-Z0-9]/g, "") : null;
const hostOf = (value) => {
  try { return value ? new URL(value).hostname.toLowerCase() : null; } catch { return null; }
};
const isOfficialHost = (host) => Boolean(host && ["dmm.co.jp", "fanza.co.jp"]
  .some((domain) => host === domain || host.endsWith(`.${domain}`)));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function inReadOnlyTransaction(operation) {
  return sql.begin("read only", async (transaction) => {
    const [session] = await transaction`
      select current_setting('transaction_read_only') as transaction_read_only
    `;
    if (session.transaction_read_only !== "on") {
      throw new Error("DATABASE_READ_ONLY_GUARD_FAILED");
    }
    return operation(transaction);
  });
}

async function databaseSnapshot(database) {
  const [videos] = await database`
    select count(*)::integer as count,
      count(*) filter (where is_published)::integer as published,
      count(*) filter (where not is_published)::integer as unpublished,
      md5(coalesce(jsonb_agg(to_jsonb(v) order by id)::text, '[]')) as digest
    from public.videos v
  `;
  const [sources] = await database`
    select count(*)::integer as count,
      md5(coalesce(jsonb_agg(to_jsonb(s) order by id)::text, '[]')) as digest
    from public.source_products s
  `;
  const [jobs] = await database`select count(*)::integer as count from public.fanza_import_jobs`;
  const [errors] = await database`select count(*)::integer as count from public.fanza_import_errors`;
  return { videos, sources, jobs: jobs.count, errors: errors.count };
}

async function fetchPage(offset) {
  const params = new URLSearchParams({
    api_id: process.env.FANZA_API_ID.trim(),
    affiliate_id: process.env.FANZA_AFFILIATE_ID.trim(),
    site: process.env.FANZA_API_SITE?.trim() || "FANZA",
    service: process.env.FANZA_API_SERVICE?.trim() || "digital",
    floor: process.env.FANZA_API_FLOOR?.trim() || "videoa",
    hits: String(PAGE_SIZE),
    offset: String(offset),
    sort: "date",
    output: "json",
  });
  let retries = 0;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(`https://api.dmm.com/affiliate/v3/ItemList?${params}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) {
        const payload = await response.json();
        if (Number(payload?.result?.status ?? 200) >= 400) {
          throw new Error(`FANZA_API_RESPONSE_${Number(payload?.result?.status) || "ERROR"}`);
        }
        return {
          items: Array.isArray(payload?.result?.items)
            ? payload.result.items.slice(0, PAGE_SIZE)
            : [],
          retries,
        };
      }
      if (![408, 425, 429, 500, 502, 503, 504].includes(response.status)) {
        throw new Error(`FANZA_API_HTTP_${response.status}`);
      }
      if (attempt === MAX_RETRIES) throw new Error(`FANZA_API_HTTP_${response.status}`);
    } catch (error) {
      if (attempt === MAX_RETRIES) throw error;
    }
    retries++;
    await wait(Math.min(4_000, 500 * 2 ** attempt));
  }
  throw new Error("FANZA_API_NO_RESPONSE");
}

const before = await inReadOnlyTransaction(databaseSnapshot);
try {
  const rawItems = [];
  const pages = [];
  let checkpoint = 1;
  for (let page = 1; rawItems.length < TOTAL; page++) {
    const requested = Math.min(PAGE_SIZE, TOTAL - rawItems.length);
    const fetched = await fetchPage(checkpoint);
    rawItems.push(...fetched.items.slice(0, requested));
    pages.push({
      page,
      offset: checkpoint,
      requested,
      received: fetched.items.length,
      retries: fetched.retries,
    });
    checkpoint += fetched.items.length;
    if (fetched.items.length < requested) break;
  }

  const [videos, sources] = await inReadOnlyTransaction(async (database) => Promise.all([
    database`
      select id, product_code, title, actress_name, maker_name, series_name, genre,
        external_product_id
      from public.videos
    `,
    database`
      select id, external_product_id, normalized_product_code, normalized_data,
        review_status, preview_status, attempt_count, promoted_video_id, duplicate_video_id
      from public.source_products
    `,
  ]));
  const videoRows = videos.map((row) => ({
    id: row.id,
    kind: "video",
    externalProductId: row.external_product_id,
    normalizedProductCode: normalizeCode(row.product_code),
    title: row.title,
    actressNames: row.actress_name ? [row.actress_name] : [],
    makerName: row.maker_name,
    seriesName: row.series_name,
    genres: row.genre ? [row.genre] : [],
  }));
  const sourceRows = sources.map((row) => ({
    id: row.id,
    kind: "source",
    externalProductId: row.external_product_id,
    normalizedProductCode: row.normalized_product_code,
    title: row.normalized_data?.title ?? null,
    actressNames: row.normalized_data?.actressNames ?? [],
    makerName: row.normalized_data?.makerName ?? null,
    seriesName: row.normalized_data?.seriesName ?? null,
    genres: row.normalized_data?.genres ?? [],
    reviewStatus: row.review_status,
    previewStatus: row.preview_status,
    attemptCount: row.attempt_count,
    linkedVideoId: row.promoted_video_id ?? row.duplicate_video_id,
  }));
  const allExisting = [...videoRows, ...sourceRows];
  const lookup = {
    async byExternalIds(ids) {
      return new Map(ids.map((id) => [
        id,
        allExisting.filter((row) => row.externalProductId === id),
      ]));
    },
    async byNormalizedCodes(codes) {
      return new Map(codes.map((code) => [
        code,
        allExisting.filter((row) => row.normalizedProductCode === code),
      ]));
    },
  };

  const normalized = rawItems.map(normalizeFanzaItem);
  const staged = await stageFanzaItems(rawItems, lookup);
  const hasMatch = (item, rows) => rows.some((row) =>
    (item.externalProductId && row.externalProductId === item.externalProductId)
    || (item.normalizedProductCode && row.normalizedProductCode === item.normalizedProductCode));
  const externalCounts = new Map();
  const codeToExternalIds = new Map();
  for (const item of normalized) {
    if (item.externalProductId) {
      externalCounts.set(item.externalProductId, (externalCounts.get(item.externalProductId) ?? 0) + 1);
    }
    if (item.normalizedProductCode) {
      const ids = codeToExternalIds.get(item.normalizedProductCode) ?? new Set();
      if (item.externalProductId) ids.add(item.externalProductId);
      codeToExternalIds.set(item.normalizedProductCode, ids);
    }
  }

  const officialHosts = normalized.map((item) => hostOf(item.officialUrl)).filter(Boolean);
  const affiliateHosts = normalized.map((item) => hostOf(item.affiliateUrl)).filter(Boolean);
  const imageHosts = normalized.flatMap((item) => [
    hostOf(item.thumbnailUrl),
    ...item.sampleImages.map(hostOf),
  ]).filter(Boolean);
  const after = await inReadOnlyTransaction(databaseSnapshot);
  const unchanged = {
    videos: before.videos.count === after.videos.count && before.videos.digest === after.videos.digest,
    source_products: before.sources.count === after.sources.count
      && before.sources.digest === after.sources.digest,
    import_jobs: before.jobs === after.jobs,
    import_errors: before.errors === after.errors,
    publication: before.videos.published === after.videos.published
      && before.videos.unpublished === after.videos.unpublished,
  };
  const report = {
    dry_run: true,
    database_session_read_only: true,
    api_authenticated: true,
    api_received: rawItems.length,
    normalization_succeeded: normalized.filter((item) =>
      item.externalProductId && item.productCode && item.title).length,
    new_candidates: staged.counts.new,
    duplicate_with_videos: normalized.filter((item) => hasMatch(item, videoRows)).length,
    duplicate_with_source_products: normalized.filter((item) => hasMatch(item, sourceRows)).length,
    needs_review: staged.counts.needs_review,
    errors: staged.errors.length,
    missing_product_code: normalized.filter((item) => !item.productCode).length,
    missing_actress: normalized.filter((item) => item.actressNames.length === 0).length,
    missing_maker: normalized.filter((item) => !item.makerName).length,
    series_present: normalized.filter((item) => item.seriesName).length,
    series_missing: normalized.filter((item) => !item.seriesName).length,
    thumbnail_urls: normalized.filter((item) => item.thumbnailUrl).length,
    products_with_sample_images: normalized.filter((item) => item.sampleImages.length > 0).length,
    sample_image_url_count: normalized.reduce((sum, item) => sum + item.sampleImages.length, 0),
    affiliate_urls: normalized.filter((item) => item.affiliateUrl).length,
    official_urls: normalized.filter((item) => item.officialUrl).length,
    same_external_id_in_response: [...externalCounts.values()].filter((count) => count > 1).length,
    same_normalized_code_different_external_ids: [...codeToExternalIds.values()]
      .filter((ids) => ids.size > 1).length,
    needs_review_reasons: staged.products.flatMap((item) => item.reviewReasons)
      .reduce((counts, reason) => ({ ...counts, [reason]: (counts[reason] ?? 0) + 1 }), {}),
    error_reasons: staged.errors.reduce(
      (counts, error) => ({ ...counts, [error.errorType]: (counts[error.errorType] ?? 0) + 1 }),
      {},
    ),
    classifications: staged.counts,
    pagination: {
      page_size: PAGE_SIZE,
      pages: pages.length,
      offsets: pages.map((page) => page.offset),
      final_checkpoint: checkpoint,
      page_results: pages,
    },
    retry: {
      max_retries_per_page: MAX_RETRIES,
      retries_used: pages.reduce((sum, page) => sum + page.retries, 0),
    },
    domains: {
      official: [...new Set(officialHosts)],
      affiliate: [...new Set(affiliateHosts)],
      image: [...new Set(imageHosts)],
      all_official: [...officialHosts, ...affiliateHosts, ...imageHosts].every(isOfficialHost),
    },
    database_before_after: {
      videos: [before.videos.count, after.videos.count],
      published: [before.videos.published, after.videos.published],
      unpublished: [before.videos.unpublished, after.videos.unpublished],
      source_products: [before.sources.count, after.sources.count],
      import_jobs: [before.jobs, after.jobs],
      import_errors: [before.errors, after.errors],
    },
    database_unchanged: unchanged,
    timing: {
      total_seconds: Number(((performance.now() - startedAt) / 1000).toFixed(3)),
      average_page_seconds: Number((((performance.now() - startedAt) / 1000) / pages.length).toFixed(3)),
    },
    memory: {
      heap_before_mb: Number((memoryBefore / 1024 / 1024).toFixed(2)),
      heap_after_mb: Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)),
      heap_delta_mb: Number(((process.memoryUsage().heapUsed - memoryBefore) / 1024 / 1024).toFixed(2)),
    },
    secrets_exposed: false,
  };
  const serialized = JSON.stringify(report, null, 2);
  if (secretValues.some((secret) => serialized.includes(secret))) {
    throw new Error("SECRET_LEAK_DETECTED");
  }
  console.log(serialized);

  const success = rawItems.length === TOTAL
    && report.database_session_read_only
    && report.normalization_succeeded + report.errors === TOTAL
    && Object.values(unchanged).every(Boolean)
    && report.domains.all_official
    && pages.length === Math.ceil(TOTAL / PAGE_SIZE)
    && checkpoint === TOTAL + 1;
  if (!success) process.exitCode = 1;
} finally {
  await sql.end();
}
