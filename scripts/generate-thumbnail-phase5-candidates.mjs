import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { canonicalizeProductCodeValue } from "../src/lib/fanza/normalize.ts";
import { getLegacyRuntimeThumbnailOverride } from "../src/lib/fanza/media.ts";
import { PHASE4B_LEGACY_THUMBNAIL_DECISIONS } from "../src/lib/thumbnail/phase4b-legacy-registry.ts";
import { PRODUCTION_THUMBNAIL_DECISIONS } from "../src/lib/thumbnail/production-registry.ts";
import { parseCsv } from "./generate-thumbnail-production-registry.mjs";
import {
  configureThumbnailCandidateV3,
  decideThumbnailCandidateV3,
} from "./dry-run-card-thumbnail-v3-added-only.mjs";
import {
  buildPhase5CandidateRecord,
  candidateSummary,
  csvValue,
  isPhase5ThumbnailCandidatePending,
  phase5CandidateDigest,
  selectStratifiedCanary,
  serializeCandidateCsv,
} from "./lib/thumbnail-phase5-candidates.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT_DIRECTORY =
  "/Users/saitoutomoya/Documents/Codex/okazudb-state/thumbnail-reviews/phase5f";
const EXPECTED_PHASE5_COUNT = 2_117;
const PRODUCTION_SHA = "e43a484a2a3ea64626ab7c384f52d688e4666ef0";
const CONTROL_CODES = Object.freeze([
  "1START00590",
  "1SBP00423",
  "H_1784FT000062",
  "H_1784FT000064",
  "1NAMHS00006",
  "AQUGL00004",
  "5561SGKT00002",
  "EBWH00344",
  "H_068MXDLP00335",
  "1SBP00416",
]);

const text = (value) => typeof value === "string" && value.trim() ? value.trim() : "";
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

async function atomicWrite(file, contents) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  await fs.writeFile(temporary, contents);
  await fs.rename(temporary, file);
}

async function fetchAll(db, table, select, configure = (query) => query) {
  const rows = [];
  const pageSize = 1_000;
  for (let from = 0; ; from += pageSize) {
    let query = db.from(table).select(select).range(from, from + pageSize - 1);
    query = configure(query);
    const { data, error } = await query;
    if (error) throw new Error(`${table}:${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

function canonicalCode(value) {
  const result = canonicalizeProductCodeValue(value);
  return result.canonical && !result.rejected ? result.canonical : text(value).toUpperCase();
}

function parseArguments(args) {
  const options = {
    outputDirectory: process.env.PHASE5_THUMBNAIL_REVIEW_DIR || DEFAULT_OUTPUT_DIRECTORY,
    cacheDirectory: process.env.PHASE5_THUMBNAIL_CACHE_DIR
      || "/private/tmp/db-web-x-ai-mvp-1-phase5f-candidate-cache",
    expectedCount: EXPECTED_PHASE5_COUNT,
    allowDynamicCount: false,
    resume: true,
    limit: null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--output-dir") options.outputDirectory = path.resolve(args[++index]);
    else if (value === "--cache-dir") options.cacheDirectory = path.resolve(args[++index]);
    else if (value === "--expected-count") options.expectedCount = Number(args[++index]);
    else if (value === "--allow-dynamic-count") options.allowDynamicCount = true;
    else if (value === "--no-resume") options.resume = false;
    else if (value === "--limit") options.limit = Number(args[++index]);
    else throw new Error(`PHASE5_CANDIDATE:UNKNOWN_ARGUMENT:${value}`);
  }
  if (!Number.isInteger(options.expectedCount) || options.expectedCount < 1) {
    throw new Error("PHASE5_CANDIDATE:INVALID_EXPECTED_COUNT");
  }
  if (options.limit !== null && (!Number.isInteger(options.limit) || options.limit < 1)) {
    throw new Error("PHASE5_CANDIDATE:INVALID_LIMIT");
  }
  return options;
}

async function readProtectedCodes() {
  const source = await fs.readFile(
    path.join(root, "data", "thumbnail-phase4b-human-review-exclusions.csv"),
    "utf8",
  );
  return new Set(parseCsv(source).map((row) => canonicalCode(row.code)));
}

function bestSourceProduct(video, byPromotedVideo, byCode) {
  return byPromotedVideo.get(video.id)
    ?? byCode.get(canonicalCode(video.product_code))
    ?? null;
}

function checkpointLine(payload) {
  return `${JSON.stringify(payload)}\n`;
}

async function loadCheckpoint(file) {
  try {
    const contents = await fs.readFile(file, "utf8");
    return new Map(contents
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .map((entry) => [entry.record.product_code, entry]));
  } catch (error) {
    if (error?.code === "ENOENT") return new Map();
    throw error;
  }
}

function candidateForMode(row, type) {
  return row?.candidates?.find((candidate) => candidate.type === type) ?? null;
}

function html(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function candidateFigure(label, candidate, record) {
  if (!candidate) return `<figure><div class="missing">候補なし</div><figcaption>${html(label)}</figcaption></figure>`;
  const isCrop = candidate.type === "dvd_right" || candidate.type === "dvd_center";
  const source = candidate.sourceUrl || candidate.url;
  const position = candidate.type === "dvd_right" ? "right" : "center";
  const sourceId = candidate.type === "sample"
    ? `sample:${candidate.sampleIndex}`
    : candidate.type === "dvd_right"
      ? "dvd:right"
      : candidate.type === "dvd_center"
        ? "dvd:center"
        : "dvd:full";
  return `<figure>
    <div class="frame ${isCrop ? "crop" : "full"}"><img src="${html(source)}" alt="${html(record.product_code)} ${html(label)}" loading="lazy" style="object-position:${position}"></div>
    <figcaption><strong>${html(label)}</strong><br>${html(sourceId)} / score ${html(candidate.score)}<br>${html((candidate.reasons ?? []).join(", ") || "highest_total_score")}</figcaption>
  </figure>`;
}

function reviewHtml(canary, detailsByCode) {
  const rows = canary.map((record) => {
    const row = detailsByCode.get(record.product_code);
    const recommended = row?.candidates?.[0] ?? null;
    const bestSample = row?.candidates?.find((candidate) => candidate.type === "sample" && !candidate.excluded) ?? null;
    return `<article>
      <h2>${html(record.product_code)} — ${html(record.candidate_mode)} / ${html(record.candidate_source_id)}</h2>
      <p>confidence ${html(record.confidence)} / class ${html(record.classification)} / risk ${html(record.risk)} / apply=false</p>
      <div class="grid">
        <figure><div class="frame full"><img src="${html(record.current_url)}" alt="${html(record.product_code)} current" loading="lazy"></div><figcaption><strong>現在</strong><br>${html(record.current_source_id)}</figcaption></figure>
        ${candidateFigure("推奨", recommended, record)}
        ${candidateFigure("DVD全面", candidateForMode(row, "dvd_full"), record)}
        ${candidateFigure("DVD右側", candidateForMode(row, "dvd_right"), record)}
        ${candidateFigure("DVD中央", candidateForMode(row, "dvd_center"), record)}
        ${candidateFigure("best sample", bestSample, record)}
      </div>
      <p class="note">理由: ${html(record.candidate_reasons)} / reviewer_note: ____________________</p>
    </article>`;
  }).join("\n");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Phase 5F Canary 30</title><style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:20px;background:#f5f5f5;color:#171717}article{background:white;border:1px solid #ddd;border-radius:12px;padding:16px;margin:0 0 20px}h2{font-size:18px;margin:0 0 6px}.grid{display:grid;grid-template-columns:repeat(3,minmax(160px,1fr));gap:12px}figure{margin:0}.frame{width:min(100%,260px);aspect-ratio:7/10;margin-inline:auto;background:#eee;overflow:hidden;display:flex;align-items:center;justify-content:center}.frame img{width:100%;height:100%;object-fit:scale-down;object-position:center}.frame.crop img{object-fit:cover}figcaption{font-size:12px;line-height:1.45;margin-top:5px;overflow-wrap:anywhere}.missing{padding:40px 8px;color:#777}.note{font-size:12px;overflow-wrap:anywhere}@media(max-width:760px){.grid{grid-template-columns:repeat(2,minmax(130px,1fr))}}
  </style></head><body><h1>Phase 5F Canary 30</h1><p>全件apply=false。RIGHT/CENTERは元package URLをcrop provenanceに従ってpreview表示し、public画像は生成していません。</p>${rows}</body></html>`;
}

function canaryCsv(records) {
  const fields = [
    "product_code", "current", "recommended", "recommended_mode", "source_id",
    "confidence", "score", "reason", "risk", "apply", "reviewer_note",
  ];
  const rows = records.map((record) => ({
    product_code: record.product_code,
    current: record.current_url,
    recommended: record.candidate_url,
    recommended_mode: record.candidate_mode,
    source_id: record.candidate_source_id,
    confidence: record.confidence,
    score: record.score,
    reason: record.candidate_reasons,
    risk: record.risk,
    apply: false,
    reviewer_note: "",
  }));
  return `${[fields.join(","), ...rows.map((row) => fields.map((field) => csvValue(row[field])).join(","))].join("\n")}\n`;
}

function controlSnapshot(videosByCode) {
  return CONTROL_CODES.map((inputCode) => {
    const code = canonicalCode(inputCode);
    const video = videosByCode.get(code) ?? null;
    const production = PRODUCTION_THUMBNAIL_DECISIONS.get(code) ?? null;
    const phase4b = PHASE4B_LEGACY_THUMBNAIL_DECISIONS.get(code) ?? null;
    return {
      input_code: inputCode,
      canonical_code: code,
      video_id: video?.id ?? null,
      mode: production?.mode ?? phase4b?.mode ?? null,
      source_id: production?.source_id ?? phase4b?.source_id ?? null,
      url: production?.output_path_or_url ?? phase4b?.resolved_url ?? video?.card_thumbnail_url ?? null,
      protected_from_phase5_generator: true,
    };
  });
}

export async function runPhase5CandidateGenerator(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) throw new Error("PHASE5_CANDIDATE:SUPABASE_ENV_MISSING");
  const outputDirectory = path.resolve(options.outputDirectory);
  const cacheDirectory = path.resolve(options.cacheDirectory);
  await fs.mkdir(outputDirectory, { recursive: true });
  await fs.mkdir(cacheDirectory, { recursive: true });
  configureThumbnailCandidateV3({
    repositoryRoot: root,
    outputDirectory,
    cacheDirectory: path.join(cacheDirectory, "images"),
  });

  const db = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const [videos, sourceProducts, protectedCodes] = await Promise.all([
    fetchAll(
      db,
      "videos",
      "id,product_code,title,maker_name,series_name,label_name,genre,thumbnail_url,card_thumbnail_url,sample_images,is_published,source_name,external_product_id,created_at,source_checked_at",
      (query) => query.eq("is_published", true).order("id", { ascending: true }),
    ),
    fetchAll(
      db,
      "source_products",
      "id,external_product_id,normalized_product_code,normalized_data,import_job_id,promoted_video_id,created_at",
      (query) => query.order("id", { ascending: true }),
    ),
    readProtectedCodes(),
  ]);
  const sourceByPromotedVideo = new Map();
  const sourceByCode = new Map();
  for (const sourceProduct of sourceProducts) {
    if (sourceProduct.promoted_video_id) sourceByPromotedVideo.set(sourceProduct.promoted_video_id, sourceProduct);
    const code = canonicalCode(sourceProduct.normalized_product_code || sourceProduct.external_product_id);
    if (code && !sourceByCode.has(code)) sourceByCode.set(code, sourceProduct);
  }
  const videosByCode = new Map(videos.map((video) => [canonicalCode(video.product_code), video]));
  const cohort = videos.filter((video) => {
    const code = canonicalCode(video.product_code);
    return isPhase5ThumbnailCandidatePending({
      video,
      hasProductionDecision: PRODUCTION_THUMBNAIL_DECISIONS.has(code),
      hasPhase4BDecision: PHASE4B_LEGACY_THUMBNAIL_DECISIONS.has(code),
      hasLegacyOverride: Boolean(getLegacyRuntimeThumbnailOverride(code)),
      isProtectedExclusion: protectedCodes.has(code),
    });
  }).sort((left, right) => canonicalCode(left.product_code).localeCompare(canonicalCode(right.product_code), "en"));

  if (!options.allowDynamicCount && cohort.length !== options.expectedCount) {
    throw new Error(`PHASE5_CANDIDATE:COHORT_COUNT_MISMATCH:${cohort.length}:${options.expectedCount}`);
  }
  const selectedCohort = options.limit ? cohort.slice(0, options.limit) : cohort;
  const checkpointPath = path.join(cacheDirectory, "candidate-state.jsonl");
  const checkpoint = options.resume ? await loadCheckpoint(checkpointPath) : new Map();
  if (!options.resume) await fs.rm(checkpointPath, { force: true });
  const append = await fs.open(checkpointPath, "a");
  const records = [];
  const detailsByCode = new Map();
  try {
    let processed = 0;
    for (const video of selectedCohort) {
      const code = canonicalCode(video.product_code);
      const prior = checkpoint.get(code);
      if (prior) {
        records.push(prior.record);
        detailsByCode.set(code, prior.v3Row);
      } else {
        const v3Row = await decideThumbnailCandidateV3(video, {
          deduplicateSamplePairs: true,
          preferSmallSampleProxy: false,
          sampleConcurrency: 2,
        });
        const sourceProduct = bestSourceProduct(video, sourceByPromotedVideo, sourceByCode);
        const record = buildPhase5CandidateRecord({ video, sourceProduct, v3Row });
        records.push(record);
        detailsByCode.set(code, v3Row);
        await append.write(checkpointLine({ record, v3Row }));
      }
      processed += 1;
      if (processed % 25 === 0 || processed === selectedCohort.length) {
        process.stdout.write(`${JSON.stringify({ processed, total: selectedCohort.length })}\n`);
      }
    }
  } finally {
    await append.close();
  }

  records.sort((left, right) => left.product_code.localeCompare(right.product_code, "en"));
  const canary = selectStratifiedCanary(records);
  if (!options.limit && canary.length !== 30) {
    throw new Error(`PHASE5_CANDIDATE:CANARY_COUNT_MISMATCH:${canary.length}:30`);
  }
  const inventory = serializeCandidateCsv(records);
  const canaryCsvSource = canaryCsv(canary);
  const reviewSource = reviewHtml(canary, detailsByCode);
  const summary = {
    production_sha: PRODUCTION_SHA,
    generated_at: new Date().toISOString(),
    read_only: true,
    discovery: "published FANZA + explicit decision absent + not Phase4B protected",
    cohort_total: cohort.length,
    processed_total: selectedCohort.length,
    expected_phase5_total: options.expectedCount,
    candidate_digest: phase5CandidateDigest(records),
    inventory_sha256: sha256(inventory),
    canary_sha256: sha256(canaryCsvSource),
    review_html_sha256: sha256(reviewSource),
    summary: candidateSummary(records),
    canary: {
      total: canary.length,
      by_mode: canary.reduce((counts, record) => {
        counts[record.candidate_mode] = (counts[record.candidate_mode] ?? 0) + 1;
        return counts;
      }, {}),
      product_codes: canary.map((record) => record.product_code),
    },
    controls: controlSnapshot(videosByCode),
    production_isolation: {
      apply_true: 0,
      db_write: 0,
      public_image_write: 0,
      scene_crop_generated: 0,
    },
  };
  await Promise.all([
    atomicWrite(path.join(outputDirectory, "candidate-inventory.csv"), inventory),
    atomicWrite(path.join(outputDirectory, "canary-30.csv"), canaryCsvSource),
    atomicWrite(path.join(outputDirectory, "contact-sheet.html"), reviewSource),
    atomicWrite(path.join(outputDirectory, "candidate-summary.json"), `${JSON.stringify(summary, null, 2)}\n`),
  ]);
  await fs.rm(checkpointPath, { force: true });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await runPhase5CandidateGenerator();
