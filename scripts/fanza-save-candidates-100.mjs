import { createClient } from "@supabase/supabase-js";
import { parseFanzaPaginationCli } from "../src/lib/fanza/pagination.ts";
import { stageFanzaItems } from "../src/lib/fanza/pipeline.ts";
import { persistStagedFanzaProducts } from "../src/lib/fanza/persistence.ts";

const pagination = parseFanzaPaginationCli(process.argv.slice(2), { maxItems: 100, pageSize: 100, sort: "date" });
const TOTAL = Math.min(1_000, pagination.maxItems);
const PAGE_SIZE = process.argv.some((argument) => argument.startsWith("--page-size="))
  ? Math.min(pagination.pageSize, TOTAL)
  : (TOTAL > 100 ? 100 : 10);
for (const key of [
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "FANZA_API_ID",
  "FANZA_AFFILIATE_ID",
]) {
  if (!process.env[key]?.trim()) throw new Error(`${key} is required`);
}
const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const normalizeCode = (value) =>
  typeof value === "string" ? value.toUpperCase().replace(/[^A-Z0-9]/g, "") : null;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchPage(offset) {
  const params = new URLSearchParams({
    api_id: process.env.FANZA_API_ID.trim(),
    affiliate_id: process.env.FANZA_AFFILIATE_ID.trim(),
    site: process.env.FANZA_API_SITE?.trim() || "FANZA",
    service: process.env.FANZA_API_SERVICE?.trim() || "digital",
    floor: process.env.FANZA_API_FLOOR?.trim() || "videoa",
    hits: String(PAGE_SIZE),
    offset: String(offset),
    sort: pagination.sort,
    output: "json",
  });
  for (let attempt = 0; attempt <= 3; attempt++) {
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
        return Array.isArray(payload?.result?.items)
          ? payload.result.items.slice(0, PAGE_SIZE)
          : [];
      }
      if (![408, 425, 429, 500, 502, 503, 504].includes(response.status)) {
        throw new Error(`FANZA_API_HTTP_${response.status}`);
      }
      if (attempt === 3) throw new Error(`FANZA_API_HTTP_${response.status}`);
    } catch (error) {
      if (attempt === 3) throw error;
    }
    await wait(Math.min(4_000, 500 * 2 ** attempt));
  }
  throw new Error("FANZA_API_NO_RESPONSE");
}

const { data: source, error: sourceError } = await admin.from("data_sources")
  .select("id").eq("name", "FANZA Webサービス").single();
if (sourceError) throw new Error("FANZA_DATA_SOURCE_NOT_FOUND");

const count = async (table) => {
  const { count: value, error } = await admin.from(table).select("id", { count: "exact", head: true });
  if (error) throw new Error(`${table.toUpperCase()}_COUNT_FAILED`);
  return value ?? 0;
};
const publicationCounts = async () => {
  const [{ count: published, error: publishedError }, { count: unpublished, error: unpublishedError }] =
    await Promise.all([
      admin.from("videos").select("id", { count: "exact", head: true }).eq("is_published", true),
      admin.from("videos").select("id", { count: "exact", head: true }).eq("is_published", false),
    ]);
  if (publishedError || unpublishedError) throw new Error("VIDEO_PUBLICATION_COUNT_FAILED");
  return { published: published ?? 0, unpublished: unpublished ?? 0 };
};
const before = {
  videos: await count("videos"),
  sources: await count("source_products"),
  publication: await publicationCounts(),
};

const { data: job, error: jobError } = await admin.from("fanza_import_jobs").insert({
  data_source_id: source.id,
  status: "running",
  page_size: PAGE_SIZE,
  max_items: TOTAL,
  next_offset: pagination.startOffset,
  dry_run: false,
  started_at: new Date().toISOString(),
}).select("*").single();
if (jobError) throw new Error("FANZA_JOB_CREATE_FAILED");

let processed = 0;
let stagedCount = 0;
let needsReview = 0;
let unchangedCount = 0;
let duplicateCount = 0;
let failedCount = 0;
let offset = pagination.startOffset;

try {
  while (processed < TOTAL) {
    const rawItems = await fetchPage(offset);
    if (!rawItems.length) break;
    const normalized = rawItems.map((item) => {
      const externalProductId = typeof item?.content_id === "string"
        ? item.content_id
        : typeof item?.product_id === "string" ? item.product_id : "";
      const productCode = typeof item?.product_id === "string"
        ? item.product_id
        : typeof item?.content_id === "string" ? item.content_id : null;
      return { externalProductId, normalizedProductCode: normalizeCode(productCode) };
    });
    const externalIds = [...new Set(normalized.map((item) => item.externalProductId).filter(Boolean))];
    const codes = [...new Set(normalized.map((item) => item.normalizedProductCode).filter(Boolean))];

    const [{ data: videos, error: videoError }, { data: sources, error: candidateError }] =
      await Promise.all([
        admin.rpc("match_videos_for_import", {
          external_ids: externalIds,
          normalized_codes: codes.map((code) => code.toLowerCase()),
        }),
        admin.from("source_products").select("*").eq("data_source_id", source.id)
          .or(`external_product_id.in.(${externalIds.join(",")}),normalized_product_code.in.(${codes.join(",")})`),
      ]);
    if (videoError || candidateError) throw new Error("FANZA_DEDUPLICATION_FAILED");

    const videoRows = (videos ?? []).map((row) => ({
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
    const sourceRows = (sources ?? []).map((row) => ({
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
    const existing = [...videoRows, ...sourceRows];
    const lookup = {
      async byExternalIds(ids) {
        return new Map(ids.map((id) => [
          id,
          existing.filter((row) => row.externalProductId === id),
        ]));
      },
      async byNormalizedCodes(values) {
        return new Map(values.map((code) => [
          code,
          existing.filter((row) => row.normalizedProductCode === code),
        ]));
      },
    };
    const result = await stageFanzaItems(rawItems, lookup);
    const now = new Date().toISOString();
    await persistStagedFanzaProducts({
      admin,
      dataSourceId: source.id,
      importJobId: job.id,
      products: result.products,
      fetchedAt: now,
    });

    if (result.errors.length) {
      failedCount += result.errors.length;
      const errorRows = result.errors.map((error) => ({
        job_id: job.id,
        external_product_id: error.externalProductId,
        original_product_code: error.originalProductCode,
        api_offset: offset + error.index,
        processing_stage: error.stage,
        error_type: error.errorType,
        attempt_count: 1,
        message: error.message.slice(0, 1000),
        raw_payload: error.rawPayload,
        retryable: error.retryable,
      }));
      await admin.from("fanza_import_errors").insert(errorRows);
    }
    processed += result.processed;
    stagedCount += result.staged;
    needsReview += result.counts.needs_review;
    unchangedCount += result.counts.unchanged;
    duplicateCount += result.counts.duplicate;
    offset += result.processed;
    const status = processed >= TOTAL ? "completed" : "paused";
    const { error: updateError } = await admin.from("fanza_import_jobs").update({
      status,
      next_offset: offset,
      processed_count: processed,
      staged_count: stagedCount,
      needs_review_count: needsReview,
      unchanged_count: unchangedCount,
      duplicate_count: duplicateCount,
      failed_count: failedCount,
      completed_at: status === "completed" ? now : null,
      last_error: null,
    }).eq("id", job.id);
    if (updateError) throw new Error("FANZA_JOB_CHECKPOINT_FAILED");
  }
} catch (error) {
  await admin.from("fanza_import_jobs").update({
    status: "failed",
    next_offset: offset,
    processed_count: processed,
    staged_count: stagedCount,
    failed_count: failedCount + 1,
    last_error: error instanceof Error ? error.message : "FANZA_IMPORT_FAILED",
  }).eq("id", job.id);
  throw error;
}

const [{ data: finalJob, error: finalJobError }, { count: itemErrors, error: itemError }] =
  await Promise.all([
    admin.from("fanza_import_jobs").select("*").eq("id", job.id).single(),
    admin.from("fanza_import_errors").select("id", { count: "exact", head: true }).eq("job_id", job.id),
  ]);
if (finalJobError || itemError) throw new Error("FANZA_JOB_VERIFY_FAILED");
const { count: missingActress, error: missingError } = await admin.from("source_products")
  .select("id", { count: "exact", head: true })
  .eq("import_job_id", job.id)
  .eq("preview_status", "needs_review");
if (missingError) throw new Error("FANZA_MISSING_ACTRESS_VERIFY_FAILED");
const after = {
  videos: await count("videos"),
  sources: await count("source_products"),
  publication: await publicationCounts(),
};
console.log(JSON.stringify({
  job_id: finalJob.id,
  status: finalJob.status,
  start_offset: pagination.startOffset,
  end_offset: offset - 1,
  sort: pagination.sort,
  processed: Number(finalJob.processed_count),
  staged: Number(finalJob.staged_count),
  needs_review: Number(finalJob.needs_review_count),
  source_products_before_after: [before.sources, after.sources],
  videos_before_after: [before.videos, after.videos],
  published_before_after: [before.publication.published, after.publication.published],
  unpublished_before_after: [before.publication.unpublished, after.publication.unpublished],
  missing_actress_saved: missingActress ?? 0,
  errors: itemErrors ?? 0,
  secrets_exposed: false,
}, null, 2));
