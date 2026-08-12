import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import postgres from "postgres";
import { normalizeFanzaItem } from "../src/lib/fanza/normalize.ts";
import {
  fanzaWindowEndOffset,
  parseFanzaPaginationCli,
} from "../src/lib/fanza/pagination.ts";
import { stageFanzaItems } from "../src/lib/fanza/pipeline.ts";

const options = new Map();
const paginationArguments = [];
for (const argument of process.argv.slice(2)) {
  if (argument.startsWith("--output=") || argument.startsWith("--summary=")
    || argument.startsWith("--previous-import-job-id=")) {
    const [name, ...value] = argument.slice(2).split("=");
    options.set(name, value.join("="));
  } else paginationArguments.push(argument);
}
const pagination = parseFanzaPaginationCli(paginationArguments, {
  startOffset: 1,
  maxItems: 1_000,
  pageSize: 100,
  sort: "date",
});
if (pagination.maxItems > 1_000) throw new Error("PHASE5C_MAX_ITEMS_1000");
const outputPath = String(options.get("output") ?? "");
const summaryPath = String(options.get("summary") ?? "");
const previousImportJobId = String(options.get("previous-import-job-id") ?? "");
if (!outputPath.endsWith(".jsonl.gz") || !summaryPath.endsWith(".json")) {
  throw new Error("OUTPUT_JSONL_GZ_AND_SUMMARY_JSON_REQUIRED");
}
for (const key of ["SUPABASE_DB_URL", "FANZA_API_ID", "FANZA_AFFILIATE_ID"]) {
  if (!process.env[key]?.trim()) throw new Error(`${key} is required`);
}

const sql = postgres(process.env.SUPABASE_DB_URL, {
  ssl: "require",
  max: 1,
  prepare: false,
  connect_timeout: 20,
  idle_timeout: 20,
});
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const normalizeCode = (value) => typeof value === "string"
  ? value.toUpperCase().replace(/[^A-Z0-9]/g, "")
  : null;

async function snapshot(database) {
  const [videos] = await database`
    select count(*)::integer as count,
      count(*) filter (where is_published)::integer as public
    from public.videos
  `;
  const [sources] = await database`
    select count(*)::integer as count,
      count(*) filter (where review_status = 'pending')::integer as pending,
      count(*) filter (where preview_status = 'needs_review')::integer as needs_review
    from public.source_products
  `;
  const [jobs] = await database`select count(*)::integer as count from public.fanza_import_jobs`;
  return { videos: videos.count, public: videos.public, source_products: sources.count,
    pending: sources.pending, needs_review: sources.needs_review, jobs: jobs.count };
}

async function fetchPage(offset, requested) {
  const params = new URLSearchParams({
    api_id: process.env.FANZA_API_ID.trim(),
    affiliate_id: process.env.FANZA_AFFILIATE_ID.trim(),
    site: process.env.FANZA_API_SITE?.trim() || "FANZA",
    service: process.env.FANZA_API_SERVICE?.trim() || "digital",
    floor: process.env.FANZA_API_FLOOR?.trim() || "videoa",
    hits: String(requested),
    offset: String(offset),
    sort: pagination.sort,
    output: "json",
  });
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      const response = await fetch(`https://api.dmm.com/affiliate/v3/ItemList?${params}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
        cache: "no-store",
      });
      if (response.ok) {
        const payload = await response.json();
        if (Number(payload?.result?.status ?? 200) >= 400) {
          throw new Error(`FANZA_API_RESPONSE_${Number(payload?.result?.status) || "ERROR"}`);
        }
        return Array.isArray(payload?.result?.items)
          ? payload.result.items.slice(0, requested)
          : [];
      }
      if (![408, 425, 429, 500, 502, 503, 504].includes(response.status) || attempt === 3) {
        throw new Error(`FANZA_API_HTTP_${response.status}`);
      }
    } catch (error) {
      if (attempt === 3) throw error;
    }
    await wait(Math.min(4_000, 500 * 2 ** attempt));
  }
  throw new Error("FANZA_API_NO_RESPONSE");
}

const before = await sql.begin("read only", async (database) => snapshot(database));
try {
  const runTimestamp = new Date().toISOString();
  const rawItems = [];
  const pageOffsets = [];
  let offset = pagination.startOffset;
  while (rawItems.length < pagination.maxItems) {
    const requested = Math.min(pagination.pageSize, pagination.maxItems - rawItems.length);
    const page = await fetchPage(offset, requested);
    pageOffsets.push(offset);
    rawItems.push(...page);
    offset += page.length;
    if (page.length < requested) break;
  }
  const normalized = rawItems.map(normalizeFanzaItem);
  const { videos, sources, previousIds } = await sql.begin("read only", async (database) => {
    const videoRows = await database`
      select id, product_code, title, actress_name, maker_name, series_name, genre, external_product_id
      from public.videos
    `;
    const sourceRows = await database`
      select id, external_product_id, normalized_product_code, normalized_data,
        review_status, preview_status, attempt_count, promoted_video_id, duplicate_video_id
      from public.source_products
    `;
    const previous = previousImportJobId
      ? await database`select external_product_id from public.source_products where import_job_id = ${previousImportJobId}`
      : [];
    return { videos: videoRows, sources: sourceRows, previousIds: new Set(previous.map((row) => row.external_product_id)) };
  });
  const existingRows = [
    ...videos.map((row) => ({
      id: row.id,
      kind: "video",
      externalProductId: row.external_product_id,
      normalizedProductCode: normalizeCode(row.product_code),
      title: row.title,
      actressNames: row.actress_name ? [row.actress_name] : [],
      makerName: row.maker_name,
      seriesName: row.series_name,
      genres: row.genre ? [row.genre] : [],
    })),
    ...sources.map((row) => ({
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
    })),
  ];
  const lookup = {
    async byExternalIds(ids) {
      return new Map(ids.map((id) => [id, existingRows.filter((row) => row.externalProductId === id)]));
    },
    async byNormalizedCodes(codes) {
      return new Map(codes.map((code) => [code, existingRows.filter((row) => row.normalizedProductCode === code)]));
    },
  };
  const staged = await stageFanzaItems(rawItems, lookup);
  const productsById = new Map(staged.products.map((product) => [product.externalProductId, product]));
  const errorIndexes = new Map(staged.errors.map((error) => [error.index, error]));
  const seenIds = new Set();
  const counts = { EXISTING_UNCHANGED: 0, EXISTING_UPDATE: 0, SAFE_NEW: 0,
    NEEDS_REVIEW: 0, DUPLICATE: 0, INVALID: 0, ERROR: 0 };
  const records = rawItems.map((rawPayload, index) => {
    const item = normalized[index];
    const error = errorIndexes.get(index);
    const repeated = item.externalProductId && seenIds.has(item.externalProductId);
    if (item.externalProductId) seenIds.add(item.externalProductId);
    const product = productsById.get(item.externalProductId);
    let classification;
    let reasons = [];
    if (error) {
      classification = "ERROR";
      reasons = [error.errorType];
    } else if (!product) {
      classification = repeated ? "DUPLICATE" : "INVALID";
      reasons = [repeated ? "same_window_external_id_duplicate" : "staged_product_missing"];
    } else if (repeated) {
      classification = "DUPLICATE";
      reasons = ["same_window_external_id_duplicate"];
    } else if (product.previewStatus === "new" && product.reviewReasons.length === 0) {
      classification = "SAFE_NEW";
    } else if (product.previewStatus === "unchanged") {
      classification = "EXISTING_UNCHANGED";
    } else if (product.previewStatus === "update") {
      classification = "EXISTING_UPDATE";
    } else if (product.previewStatus === "duplicate"
      || product.reviewReasons.some((reason) => /duplicate|collision|ambiguous/.test(reason))) {
      classification = "DUPLICATE";
      reasons = product.reviewReasons;
    } else if (product.previewStatus === "needs_review") {
      classification = "NEEDS_REVIEW";
      reasons = product.reviewReasons;
    } else {
      classification = "INVALID";
      reasons = ["classification_unmapped"];
    }
    counts[classification]++;
    return {
      run_timestamp: runTimestamp,
      source_position: index + 1,
      source_offset: pagination.startOffset + index,
      external_product_id: item.externalProductId,
      product_code: item.productCode,
      normalized_product_code: item.normalizedProductCode,
      release_date: item.releaseDate,
      payload_hash: createHash("sha256").update(JSON.stringify(rawPayload)).digest("hex"),
      actress_metadata_present: item.actressNames.length > 0,
      classification,
      reason_codes: reasons,
      raw_payload: rawPayload,
      normalized: item,
    };
  });
  const jsonl = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  const manifestHash = createHash("sha256").update(jsonl).digest("hex");
  const after = await sql.begin("read only", async (database) => snapshot(database));
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("FREEZE_DATABASE_CHANGED");
  const overlapCount = records.filter((record) => previousIds.has(record.external_product_id)).length;
  const summary = {
    mode: "read_only_freeze",
    api_crawl_runs: 1,
    api_page_requests: pageOffsets.length,
    run_timestamp: runTimestamp,
    start_offset: pagination.startOffset,
    end_offset: rawItems.length ? pagination.startOffset + rawItems.length - 1 : pagination.startOffset - 1,
    configured_end_offset: fanzaWindowEndOffset(pagination),
    page_size: pagination.pageSize,
    sort: pagination.sort,
    fetched_count: rawItems.length,
    first_external_product_id: records[0]?.external_product_id ?? null,
    last_external_product_id: records.at(-1)?.external_product_id ?? null,
    first_release_date: records[0]?.release_date ?? null,
    last_release_date: records.at(-1)?.release_date ?? null,
    manifest_sha256: manifestHash,
    phase5b_safe_subset_size: previousIds.size,
    phase5b_safe_subset_overlap: overlapCount,
    phase5b_safe_subset_overlap_rate: rawItems.length ? overlapCount / rawItems.length : 0,
    classifications: counts,
    stage_errors: staged.errors.length,
    database_before: before,
    database_after: after,
  };
  await writeFile(outputPath, gzipSync(jsonl, { level: 6 }));
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await sql.end({ timeout: 1 });
}
