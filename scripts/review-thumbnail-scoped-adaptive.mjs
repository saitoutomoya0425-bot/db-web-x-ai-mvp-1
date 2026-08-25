import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  configureThumbnailCandidateV3,
  deduplicatedSampleSources,
  decideThumbnailCandidateV3,
  getThumbnailCandidateV3FetchStats,
} from "./dry-run-card-thumbnail-v3-added-only.mjs";
import {
  fetchRowsByExactValues,
  loadExactHandoff,
  validateExactScopeRows,
} from "./generate-thumbnail-phase5-candidates.mjs";
import { isPhase5ThumbnailCandidatePending } from "./lib/thumbnail-phase5-candidates.mjs";
import { PHASE4B_LEGACY_THUMBNAIL_DECISIONS } from "../src/lib/thumbnail/phase4b-legacy-registry.ts";
import { PRODUCTION_THUMBNAIL_DECISIONS } from "../src/lib/thumbnail/production-registry.ts";
import { getLegacyRuntimeThumbnailOverride } from "../src/lib/fanza/media.ts";
import { canonicalizeProductCodeValue } from "../src/lib/fanza/normalize.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT = "/Users/saitoutomoya/Documents/Codex/okazudb-state/thumbnail-reviews/phase5g-5274-6273";
const DEFAULT_CACHE = "/private/tmp/db-web-x-ai-mvp-1-phase5g-94-adaptive";
const VALID_STAGE1 = new Set(["SAMPLE_CLEARLY_NONCOMPETITIVE", "SAMPLE_POTENTIALLY_COMPETITIVE"]);
const VALID_STAGE2 = new Set(["PACKAGE_CLEAR_WIN", "SAMPLE_STILL_COMPETITIVE"]);

const text = (value) => typeof value === "string" && value.trim() ? value.trim() : "";
const canonicalCode = (value) => {
  const result = canonicalizeProductCodeValue(value);
  return result.canonical && !result.rejected ? result.canonical : text(value).toUpperCase();
};

export function parseAdaptiveReviewArgs(args) {
  const options = {
    handoffFile: null,
    outputDirectory: DEFAULT_OUTPUT,
    cacheDirectory: DEFAULT_CACHE,
    expectedCount: 94,
    stage: 1,
    stage1Max: 8,
    stage2Max: 8,
    classifications: null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--handoff-file") options.handoffFile = path.resolve(args[++index]);
    else if (value === "--output-dir") options.outputDirectory = path.resolve(args[++index]);
    else if (value === "--cache-dir") options.cacheDirectory = path.resolve(args[++index]);
    else if (value === "--expected-count") options.expectedCount = Number(args[++index]);
    else if (value === "--stage") options.stage = Number(args[++index]);
    else if (value === "--stage1-max") options.stage1Max = Number(args[++index]);
    else if (value === "--stage2-max") options.stage2Max = Number(args[++index]);
    else if (value === "--classifications") options.classifications = path.resolve(args[++index]);
    else throw new Error(`PHASE5G_ADAPTIVE:UNKNOWN_ARGUMENT:${value}`);
  }
  if (!options.handoffFile || ![1, 2, 3].includes(options.stage)) {
    throw new Error("PHASE5G_ADAPTIVE:INVALID_ARGUMENTS");
  }
  if (![options.stage1Max, options.stage2Max].every((maximum) => Number.isInteger(maximum) && maximum >= 1 && maximum <= 8)) {
    throw new Error("PHASE5G_ADAPTIVE:INVALID_STAGE_MAX");
  }
  if (options.stage > 1 && !options.classifications) {
    throw new Error("PHASE5G_ADAPTIVE:CLASSIFICATIONS_REQUIRED");
  }
  return options;
}

export function selectEvenlyDistributedIndices(total, maximum = 8) {
  if (!Number.isInteger(total) || total < 0 || !Number.isInteger(maximum) || maximum < 1) {
    throw new Error("PHASE5G_ADAPTIVE:INVALID_INDEX_RANGE");
  }
  if (total === 0) return [];
  const count = Math.min(total, maximum);
  if (count === 1) return [1];
  return [...new Set(Array.from({ length: count }, (_, index) =>
    Math.round(index * (total - 1) / (count - 1)) + 1))].sort((a, b) => a - b);
}

export function selectInterleavedIndices(total, selected, maximum = 8) {
  const chosen = new Set(selected);
  const remaining = Array.from({ length: total }, (_, index) => index + 1)
    .filter((index) => !chosen.has(index));
  const result = [];
  while (remaining.length && result.length < maximum) {
    remaining.sort((left, right) => {
      const leftDistance = Math.min(...[...chosen].map((value) => Math.abs(value - left)));
      const rightDistance = Math.min(...[...chosen].map((value) => Math.abs(value - right)));
      return rightDistance - leftDistance || left - right;
    });
    const next = remaining.shift();
    chosen.add(next);
    result.push(next);
  }
  return result.sort((a, b) => a - b);
}

function selectEvenlyDistributedValues(values, maximum = 8) {
  return selectEvenlyDistributedIndices(values.length, maximum).map((position) => values[position - 1]);
}

function selectInterleavedValues(values, selectedValues, maximum = 8) {
  const positionsByValue = new Map(values.map((value, index) => [value, index + 1]));
  const selectedPositions = selectedValues.map((value) => positionsByValue.get(value));
  return selectInterleavedIndices(values.length, selectedPositions, maximum).map((position) => values[position - 1]);
}

export function selectAdaptiveStageCodes({ stage, allCodes, works = {}, classifications = {} }) {
  if (stage === 1) return [...allCodes];
  if (stage === 2) {
    return allCodes.filter((code) => classifications[code] === "SAMPLE_POTENTIALLY_COMPETITIVE");
  }
  if (stage === 3) {
    return allCodes.filter((code) =>
      works[code]?.stage2_classification === "SAMPLE_POTENTIALLY_COMPETITIVE"
      && classifications[code] === "SAMPLE_STILL_COMPETITIVE");
  }
  throw new Error(`PHASE5G_ADAPTIVE:INVALID_STAGE:${stage}`);
}

async function atomicWrite(file, contents) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  await fs.writeFile(temporary, contents);
  await fs.rename(temporary, file);
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function loadClassifications(file, expectedCodes, allowed) {
  const payload = await readJson(file);
  const rawEntries = payload?.classifications ?? payload;
  const entries = payload?.default
    ? Object.fromEntries(expectedCodes.map((code) => [code, rawEntries[code] ?? payload.default]))
    : rawEntries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    throw new Error("PHASE5G_ADAPTIVE:INVALID_CLASSIFICATIONS");
  }
  for (const code of expectedCodes) {
    if (!allowed.has(entries[code])) throw new Error(`PHASE5G_ADAPTIVE:CLASSIFICATION_MISSING:${code}`);
  }
  const unexpected = Object.keys(rawEntries).filter((code) => !expectedCodes.includes(code));
  if (unexpected.length) throw new Error(`PHASE5G_ADAPTIVE:CLASSIFICATION_OUT_OF_SCOPE:${unexpected.join(",")}`);
  return entries;
}

function cacheFileForUrl(cacheDirectory, url) {
  const extension = path.extname(new URL(url).pathname) || ".jpg";
  return path.join(cacheDirectory, "images", `${crypto.createHash("sha1").update(url).digest("hex")}${extension}`);
}

function sourceId(candidate) {
  if (candidate.type === "sample") return `sample:${candidate.sampleIndex}`;
  if (candidate.type === "dvd_right") return "dvd:right";
  if (candidate.type === "dvd_center") return "dvd:center";
  return "dvd:full";
}

function html(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function candidateFigure(candidate, code, cacheDirectory) {
  const url = candidate.sourceUrl || candidate.url;
  const local = url.startsWith("https://") ? `file://${cacheFileForUrl(cacheDirectory, url)}` : url;
  const crop = candidate.type === "dvd_right" || candidate.type === "dvd_center";
  const position = candidate.type === "dvd_right" ? "right" : "center";
  return `<figure><div class="frame ${crop ? "crop" : "full"}"><img src="${html(local)}" alt="${html(code)} ${html(sourceId(candidate))}" loading="lazy" style="object-position:${position}"></div><figcaption><b>${html(sourceId(candidate))}</b> / score ${html(candidate.score)} / ${html(candidate.meta?.width)}×${html(candidate.meta?.height)}<br>${html((candidate.reasons ?? []).join(", ") || "highest_total_score")}</figcaption></figure>`;
}

function reviewHtml(state, codes, cacheDirectory, stage) {
  const records = codes.map((code) => state.works[code]);
  const articles = records.map((record) => {
    const order = { dvd_full: 0, dvd_right: 1, dvd_center: 2, sample: 3, vertical_package: 4 };
    const candidates = [...record.v3Row.candidates].sort((left, right) =>
      (order[left.type] ?? 9) - (order[right.type] ?? 9)
      || (left.sampleIndex ?? 0) - (right.sampleIndex ?? 0));
    return `<article><h2>${html(record.code)} — Stage ${stage}</h2><p>sample ${record.sample_count} / fetched [${record.fetched_sample_indices.join(", ")}] / current ${html(record.v3Row.current_type)}</p><div class="grid">${candidates.map((candidate) => candidateFigure(candidate, record.code, cacheDirectory)).join("\n")}</div><p class="decision">Visual classification: ____________________</p></article>`;
  }).join("\n");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Phase 5G adaptive Stage ${stage}</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f2f2f2;color:#171717;margin:18px}article{background:#fff;border:1px solid #ddd;border-radius:10px;margin:0 0 18px;padding:14px}h2{margin:0 0 6px;font-size:17px}.grid{display:grid;grid-template-columns:repeat(6,minmax(110px,1fr));gap:9px;overflow-x:auto}figure{margin:0}.frame{aspect-ratio:7/10;background:#ddd;display:flex;align-items:center;justify-content:center;overflow:hidden}.frame img{width:100%;height:100%;object-fit:scale-down}.frame.crop img{object-fit:cover}figcaption{font-size:10px;line-height:1.35;overflow-wrap:anywhere}.decision{font-weight:700}@media(max-width:900px){.grid{grid-template-columns:repeat(3,minmax(100px,1fr))}}</style></head><body><h1>Phase 5G exact ${state.expected_count} — Adaptive Stage ${stage}</h1><p>actual cached bytes only; package FULL/RIGHT/CENTER and fetched samples use the same URL cache.</p>${articles}</body></html>`;
}

function chunks(values, maximum = 50) {
  return Array.from({ length: Math.ceil(values.length / maximum) }, (_, index) =>
    values.slice(index * maximum, (index + 1) * maximum));
}

async function directoryStats(directory) {
  let bytes = 0;
  let files = 0;
  async function visit(current) {
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) { const stat = await fs.stat(target); bytes += stat.size; files += 1; }
    }
  }
  await visit(directory);
  return { bytes, files };
}

async function queryExactScope(handoff) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) throw new Error("PHASE5G_ADAPTIVE:SUPABASE_ENV_MISSING");
  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const ids = handoff.map((row) => row.video_id);
  const [videos, sources] = await Promise.all([
    fetchRowsByExactValues(db, {
      table: "videos",
      select: "id,product_code,title,maker_name,series_name,label_name,genre,thumbnail_url,card_thumbnail_url,sample_images,is_published,source_name,external_product_id,created_at,source_checked_at",
      column: "id",
      values: ids,
    }),
    fetchRowsByExactValues(db, {
      table: "source_products",
      select: "id,external_product_id,normalized_product_code,normalized_data,import_job_id,promoted_video_id,created_at",
      column: "promoted_video_id",
      values: ids,
    }),
  ]);
  const ordered = validateExactScopeRows(handoff, videos, sources);
  for (const video of ordered) {
    const code = canonicalCode(video.product_code);
    if (!isPhase5ThumbnailCandidatePending({
      video,
      hasProductionDecision: PRODUCTION_THUMBNAIL_DECISIONS.has(code),
      hasPhase4BDecision: PHASE4B_LEGACY_THUMBNAIL_DECISIONS.has(code),
      hasLegacyOverride: Boolean(getLegacyRuntimeThumbnailOverride(code)),
    })) throw new Error(`PHASE5G_ADAPTIVE:NOT_PENDING:${code}`);
  }
  return { videos: ordered, sources };
}

export async function runAdaptiveReview(args = process.argv.slice(2)) {
  const options = parseAdaptiveReviewArgs(args);
  await fs.mkdir(options.outputDirectory, { recursive: true });
  await fs.mkdir(options.cacheDirectory, { recursive: true });
  const handoff = await loadExactHandoff(options.handoffFile, options.expectedCount);
  const { videos, sources } = await queryExactScope(handoff);
  const stateFile = path.join(options.outputDirectory, "adaptive-checkpoint.json");
  const existing = await readJson(stateFile, null);
  const state = existing ?? {
    phase: path.basename(options.outputDirectory),
    handoff_file: options.handoffFile,
    membership_sha: handoff[0].frontier_membership_hash || handoff[0].membership_sha,
    expected_count: options.expectedCount,
    db_video_rows: videos.length,
    db_source_rows: sources.length,
    completed_stage: 0,
    fetched_urls: [],
    works: {},
  };
  if (state.expected_count !== options.expectedCount || state.membership_sha !== (handoff[0].frontier_membership_hash || handoff[0].membership_sha)) {
    throw new Error("PHASE5G_ADAPTIVE:CHECKPOINT_SCOPE_MISMATCH");
  }
  if (options.stage === 1 && state.selection_contract_version !== 3) {
    for (const work of Object.values(state.works)) work.stage_completed = 0;
  }
  state.selection_contract_version = 3;
  state.stage1_max = options.stage1Max;
  state.stage2_max = options.stage2Max;
  if (options.stage > state.completed_stage + 1) throw new Error("PHASE5G_ADAPTIVE:STAGE_ORDER");
  const allCodes = handoff.map((row) => row.product_code);
  let classifications = null;
  let selectedCodes = allCodes;
  if (options.stage === 2) {
    classifications = await loadClassifications(options.classifications, allCodes, VALID_STAGE1);
    selectedCodes = selectAdaptiveStageCodes({ stage: 2, allCodes, works: state.works, classifications });
  } else if (options.stage === 3) {
    const stage2Codes = allCodes.filter((code) => state.works[code]?.stage2_classification === "SAMPLE_POTENTIALLY_COMPETITIVE");
    classifications = await loadClassifications(options.classifications, stage2Codes, VALID_STAGE2);
    selectedCodes = selectAdaptiveStageCodes({ stage: 3, allCodes, works: state.works, classifications });
  }
  const videosByCode = new Map(videos.map((video) => [canonicalCode(video.product_code), video]));
  configureThumbnailCandidateV3({ repositoryRoot: root, outputDirectory: options.outputDirectory, cacheDirectory: path.join(options.cacheDirectory, "images") });
  let processed = 0;
  for (const code of allCodes) {
    const video = videosByCode.get(code);
    const sampleCount = Array.isArray(video.sample_images) ? video.sample_images.length : 0;
    const actualSampleSources = deduplicatedSampleSources(video.sample_images);
    const actualSampleIndices = actualSampleSources.map((entry) => entry.index);
    const sampleUrlByIndex = new Map(actualSampleSources.map((entry) => [entry.index, entry.url]));
    const prior = state.works[code] ?? { code, sample_count: sampleCount, actual_sample_count: actualSampleIndices.length, fetched_sample_indices: [], stage_completed: 0 };
    prior.actual_sample_count = actualSampleIndices.length;
    if (options.stage === 2) prior.stage1_classification = classifications[code];
    if (options.stage === 3 && prior.stage2_classification === "SAMPLE_POTENTIALLY_COMPETITIVE") {
      prior.stage2_review_classification = classifications[code];
    }
    if (selectedCodes.includes(code) && prior.stage_completed < options.stage) {
      const stage1 = selectEvenlyDistributedValues(actualSampleIndices, options.stage1Max);
      const stage2 = selectInterleavedValues(actualSampleIndices, stage1, options.stage2Max);
      const indices = options.stage === 1 ? stage1
        : options.stage === 2 ? [...new Set([...stage1, ...stage2])].sort((a, b) => a - b)
          : actualSampleIndices;
      const v3Row = await decideThumbnailCandidateV3(video, {
        deduplicateSamplePairs: true,
        preferSmallSampleProxy: false,
        sampleConcurrency: 4,
        candidateLimit: null,
        sampleIndices: indices,
      });
      Object.assign(prior, {
        fetched_sample_indices: indices,
        fetched_sample_urls: indices.map((index) => sampleUrlByIndex.get(index)),
        stage_completed: options.stage,
        v3Row,
      });
    } else if (prior.stage_completed < options.stage) {
      prior.stage_completed = options.stage;
    }
    if (options.stage === 2) prior.stage2_classification = classifications[code];
    state.works[code] = prior;
    processed += 1;
    if (processed % 50 === 0 || processed === allCodes.length) {
      const checkpointStats = getThumbnailCandidateV3FetchStats();
      state.fetched_urls = [...new Set([...state.fetched_urls, ...checkpointStats.urls])];
      await atomicWrite(stateFile, `${JSON.stringify(state, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify({ stage: options.stage, processed, total: allCodes.length })}\n`);
    }
  }
  const stats = getThumbnailCandidateV3FetchStats();
  state.fetched_urls = [...new Set([...state.fetched_urls, ...stats.urls])];
  state.completed_stage = Math.max(state.completed_stage, options.stage);
  const allSampleUrls = new Set(videos.flatMap((video) => deduplicatedSampleSources(video.sample_images).map((entry) => entry.url)));
  const selectedSampleUrls = new Set(Object.values(state.works).flatMap((work) => work.fetched_sample_urls ?? []));
  const networkSampleUrls = state.fetched_urls.filter((url) => allSampleUrls.has(url));
  const networkPackageUrls = state.fetched_urls.filter((url) => !allSampleUrls.has(url));
  state.network = {
    unique_urls_total: state.fetched_urls.length,
    package_urls: networkPackageUrls.length,
    sample_urls: networkSampleUrls.length,
    selected_sample_indices: Object.values(state.works).reduce((total, work) => total + (work.fetched_sample_indices?.length ?? 0), 0),
    selected_unique_sample_urls: selectedSampleUrls.size,
    actual_sample_network_gets: networkSampleUrls.length,
    duplicate_network_gets_current_process: stats.duplicateNetworkGets,
    successful_network_gets_current_process: stats.successfulNetworkGets,
    status_429_current_process: stats.status429,
    unexpected_5xx_current_process: stats.unexpected5xx,
    timeouts_current_process: stats.timeouts,
    other_failures_current_process: stats.otherFailures,
    peak_network_concurrency_current_process: stats.peakNetworkConcurrency,
    cache_race_current_process: stats.cacheRaceCount,
  };
  if (options.stage === 1) {
    const zeroSampleWorks = videos.filter((video) => deduplicatedSampleSources(video.sample_images).length === 0).length;
    const theoreticalMaximum = (videos.length - zeroSampleWorks) * options.stage1Max;
    if (state.network.selected_sample_indices > theoreticalMaximum
      || state.network.selected_unique_sample_urls > theoreticalMaximum
      || state.network.actual_sample_network_gets > theoreticalMaximum) {
      throw new Error("PHASE5G_ADAPTIVE:STAGE1_SAMPLE_GET_CAP_EXCEEDED");
    }
  }
  state.cache = await directoryStats(options.cacheDirectory);
  const reviewCodes = options.stage === 1 ? allCodes : selectedCodes;
  const reviewChunks = chunks(reviewCodes, 50);
  await Promise.all([
    atomicWrite(stateFile, `${JSON.stringify(state, null, 2)}\n`),
    ...reviewChunks.map((codes, index) => atomicWrite(
      path.join(options.outputDirectory, `review-stage${options.stage}-${String(index + 1).padStart(3, "0")}.html`),
      reviewHtml(state, codes, options.cacheDirectory, options.stage),
    )),
    atomicWrite(path.join(options.outputDirectory, `adaptive-fetch-stage${options.stage}-summary.json`), `${JSON.stringify({ stage: options.stage, reviewed_works: reviewCodes.length, selected_codes: selectedCodes, network: state.network, cache: state.cache }, null, 2)}\n`),
  ]);
  process.stdout.write(`${JSON.stringify({ stage: options.stage, exact_scope: allCodes.length, selected: selectedCodes.length, network: state.network, cache: state.cache }, null, 2)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await runAdaptiveReview();
