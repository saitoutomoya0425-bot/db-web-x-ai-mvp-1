import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { createClient } from "@supabase/supabase-js";
import { stageFanzaItems } from "../src/lib/fanza/pipeline.ts";
import {
  buildStagedFanzaSourceRows,
  persistStagedFanzaProducts,
} from "../src/lib/fanza/persistence.ts";
import { frozenSafeNewProvenanceIssues } from "./lib/fanza-frozen-provenance.mjs";

const options = new Map();
for (const argument of process.argv.slice(2)) {
  if (argument === "--write") options.set("write", true);
  else if (argument.startsWith("--") && argument.includes("=")) {
    const [name, ...value] = argument.slice(2).split("=");
    options.set(name, value.join("="));
  } else throw new Error(`UNKNOWN_ARGUMENT_${argument}`);
}
const manifestPath = String(options.get("manifest") ?? "");
const targetsPath = String(options.get("targets") ?? "");
const expectedCount = Number(options.get("expected-count"));
const importJobValue = String(options.get("import-job-id") ?? "null");
const write = options.get("write") === true;
if (!manifestPath || !targetsPath) throw new Error("MANIFEST_AND_TARGETS_REQUIRED");
if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 100) {
  throw new Error("EXPECTED_COUNT_1_TO_100_REQUIRED");
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const importJobId = importJobValue === "null" ? null : importJobValue;
if (importJobId !== null && !UUID.test(importJobId)) throw new Error("IMPORT_JOB_ID_INVALID");
for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
  if (!process.env[key]?.trim()) throw new Error(`${key} is required`);
}

async function loadJsonLines(path) {
  const bytes = await readFile(path);
  const text = path.endsWith(".gz") ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function loadTargetExternalIds(path) {
  const parsed = JSON.parse(await readFile(path, "utf8"));
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed?.categories?.NOT_SAVED;
  if (!Array.isArray(rows)) throw new Error("TARGET_FILE_FORMAT_INVALID");
  const ids = rows.map((row) => typeof row === "string" ? row : row?.external_product_id);
  if (ids.some((value) => typeof value !== "string" || !value)) throw new Error("TARGET_EXTERNAL_ID_INVALID");
  if (new Set(ids).size !== ids.length) throw new Error("TARGET_EXTERNAL_ID_DUPLICATE");
  return ids;
}

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

async function tableCount(table, filters = []) {
  let query = admin.from(table).select("id", { count: "exact", head: true });
  for (const [column, value] of filters) query = query.eq(column, value);
  const { count, error } = await query;
  if (error) throw new Error(`COUNT_FAILED_${table}`);
  return count ?? 0;
}

async function snapshot() {
  const [videos, publicVideos, sourceProducts, pending, needsReview, jobs] = await Promise.all([
    tableCount("videos"),
    tableCount("videos", [["is_published", true]]),
    tableCount("source_products"),
    tableCount("source_products", [["review_status", "pending"]]),
    tableCount("source_products", [["preview_status", "needs_review"]]),
    tableCount("fanza_import_jobs"),
  ]);
  return { videos, public: publicVideos, source_products: sourceProducts, pending, needs_review: needsReview, jobs };
}

const targetExternalIds = await loadTargetExternalIds(targetsPath);
if (targetExternalIds.length !== expectedCount) throw new Error(`TARGET_COUNT_MISMATCH_${targetExternalIds.length}`);
const targetSet = new Set(targetExternalIds);
const frozenAll = await loadJsonLines(manifestPath);
const frozen = frozenAll.filter((candidate) => targetSet.has(candidate.external_product_id));
if (frozen.length !== expectedCount) throw new Error(`FROZEN_TARGET_COUNT_MISMATCH_${frozen.length}`);
if (new Set(frozen.map((candidate) => candidate.external_product_id)).size !== expectedCount) {
  throw new Error("FROZEN_TARGET_DUPLICATE");
}

const provenanceIssues = [];
for (const candidate of frozen) {
  provenanceIssues.push(...frozenSafeNewProvenanceIssues(candidate));
}
if (provenanceIssues.length) throw new Error(`FROZEN_PROVENANCE_INCOMPLETE_${provenanceIssues.length}`);

const { data: source, error: sourceError } = await admin.from("data_sources")
  .select("id").eq("name", "FANZA Webサービス").single();
if (sourceError || !source) throw new Error("FANZA_DATA_SOURCE_NOT_FOUND");
const normalizedCodes = frozen.map((candidate) => candidate.normalized_product_code);
const [{ data: videos, error: videoError }, { data: externalSources, error: externalSourceError },
  { data: codeSources, error: codeSourceError }] = await Promise.all([
  admin.rpc("match_videos_for_import", {
    external_ids: targetExternalIds,
    normalized_codes: normalizedCodes.map((code) => code.toLowerCase()),
  }),
  admin.from("source_products").select("*").eq("data_source_id", source.id)
    .in("external_product_id", targetExternalIds),
  admin.from("source_products").select("*").eq("data_source_id", source.id)
    .in("normalized_product_code", normalizedCodes),
]);
if (videoError || externalSourceError || codeSourceError) throw new Error("LATEST_DATABASE_LOOKUP_FAILED");

const normalizeCode = (value) => typeof value === "string"
  ? value.toUpperCase().replace(/[^A-Z0-9]/g, "")
  : null;
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
const sourceRows = [...new Map([...(externalSources ?? []), ...(codeSources ?? [])]
  .map((row) => [row.id, row])).values()].map((row) => ({
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
    return new Map(ids.map((id) => [id, existing.filter((row) => row.externalProductId === id)]));
  },
  async byNormalizedCodes(codes) {
    return new Map(codes.map((code) => [code, existing.filter((row) => row.normalizedProductCode === code)]));
  },
};

const staged = await stageFanzaItems(frozen.map((candidate) => candidate.raw_payload), lookup);
const productByExternalId = new Map(staged.products.map((product) => [product.externalProductId, product]));
const classifications = { STILL_SAFE_NEW: [], NOW_EXISTING: [], NOW_DUPLICATE: [], INVALID: [] };
for (const candidate of frozen) {
  const product = productByExternalId.get(candidate.external_product_id);
  if (!product) {
    classifications.INVALID.push(candidate.external_product_id);
    continue;
  }
  const normalizedMatches = JSON.stringify(product.normalized) === JSON.stringify(candidate.normalized);
  const hashMatches = product.payloadHash === candidate.payload_hash;
  const collision = product.reviewReasons.some((reason) => /duplicate|collision|ambiguous/.test(reason));
  if (!normalizedMatches || !hashMatches || fanzaSafetyReviewReasons(product.normalized).length) {
    classifications.INVALID.push(candidate.external_product_id);
  } else if (product.previewStatus === "new" && product.reviewReasons.length === 0) {
    classifications.STILL_SAFE_NEW.push(candidate.external_product_id);
  } else if (collision || product.previewStatus === "duplicate") {
    classifications.NOW_DUPLICATE.push(candidate.external_product_id);
  } else if (["update", "unchanged"].includes(product.previewStatus)) {
    classifications.NOW_EXISTING.push(candidate.external_product_id);
  } else {
    classifications.INVALID.push(candidate.external_product_id);
  }
}
if (staged.errors.length) classifications.INVALID.push(...staged.errors.map((error) => error.externalProductId ?? "unknown"));

const productsToSave = classifications.STILL_SAFE_NEW.map((id) => productByExternalId.get(id));
if (productsToSave.some((product) => !product)) throw new Error("STILL_SAFE_NEW_PRODUCT_MISSING");
const fetchedAt = new Date().toISOString();
const plannedRows = buildStagedFanzaSourceRows({
  dataSourceId: source.id,
  importJobId,
  products: productsToSave,
  fetchedAt,
});
const before = await snapshot();
let saved = 0;
if (write && plannedRows.length) {
  const result = await persistStagedFanzaProducts({
    admin,
    dataSourceId: source.id,
    importJobId,
    products: productsToSave,
    fetchedAt,
  });
  saved = result.saved;
}
const after = await snapshot();

if (!write && JSON.stringify(before) !== JSON.stringify(after)) throw new Error("DRY_RUN_DATABASE_CHANGED");
if (write) {
  const expectedSourceDelta = productsToSave.length;
  if (after.source_products - before.source_products !== expectedSourceDelta) throw new Error("SOURCE_PRODUCT_DELTA_MISMATCH");
  if (after.pending - before.pending !== expectedSourceDelta) throw new Error("PENDING_DELTA_MISMATCH");
  if (after.videos !== before.videos || after.public !== before.public || after.jobs !== before.jobs || after.needs_review !== before.needs_review) {
    throw new Error("UNEXPECTED_DATABASE_DELTA");
  }
  const { data: savedRows, error: savedError } = await admin.from("source_products")
    .select("external_product_id,normalized_product_code,payload_hash,review_status,preview_status,import_job_id")
    .eq("data_source_id", source.id).in("external_product_id", classifications.STILL_SAFE_NEW);
  if (savedError || (savedRows ?? []).length !== expectedSourceDelta) throw new Error("SAVED_ROWS_VERIFY_FAILED");
  const plannedById = new Map(plannedRows.map((row) => [row.external_product_id, row]));
  for (const row of savedRows ?? []) {
    const planned = plannedById.get(row.external_product_id);
    if (!planned || row.normalized_product_code !== planned.normalized_product_code
      || row.payload_hash !== planned.payload_hash || row.review_status !== "pending"
      || row.preview_status !== "new" || row.import_job_id !== importJobId) {
      throw new Error(`SAVED_ROW_MISMATCH_${row.external_product_id}`);
    }
  }
}

const groups = [];
for (let index = 0; index < plannedRows.length; index += 5) {
  groups.push(plannedRows.slice(index, index + 5).map((row) => row.external_product_id));
}
console.log(JSON.stringify({
  mode: write ? "write" : "dry_run",
  fanza_api_calls: 0,
  frozen_total: frozen.length,
  provenance_complete: frozen.length - provenanceIssues.length,
  classifications: Object.fromEntries(Object.entries(classifications).map(([key, rows]) => [key, rows.length])),
  planned_source_rows: plannedRows.length,
  planned_job_linkage: importJobId,
  planned_promote_groups: groups.map((group) => group.length),
  planned_publication_count: plannedRows.length,
  saved,
  database_before: before,
  database_after: after,
}, null, 2));
