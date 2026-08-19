import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { canonicalizeProductCodeValue } from "../src/lib/fanza/normalize.ts";
import { PRODUCTION_THUMBNAIL_DECISIONS } from "../src/lib/thumbnail/production-registry.ts";
import { parseCsv } from "./generate-thumbnail-production-registry.mjs";
import { configureThumbnailCandidateV3, decideThumbnailCandidateV3 } from "./dry-run-card-thumbnail-v3-added-only.mjs";
import { buildPhase5CandidateRecord } from "./lib/thumbnail-phase5-candidates.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CALIBRATION_DIRECTORY = "/Users/saitoutomoya/Documents/Codex/okazudb-state/thumbnail-reviews/phase5f-calibration";
const DEFAULT_OUTPUT_DIRECTORY = "/Users/saitoutomoya/Documents/Codex/okazudb-state/thumbnail-reviews/phase5f-tuning";
const DEFAULT_CACHE_DIRECTORY = "/private/tmp/db-web-x-ai-mvp-1-phase5f-tuning-cache";
const CALIBRATION_MODES = new Set(["SAMPLE", "PACKAGE_RIGHT", "PACKAGE_CENTER", "PACKAGE_FULL"]);
const text = (value) => typeof value === "string" && value.trim() ? value.trim() : "";

function canonicalCode(value) {
  const result = canonicalizeProductCodeValue(value);
  return result.canonical && !result.rejected ? result.canonical : text(value).toUpperCase();
}

function parseArguments(args) {
  const options = {
    label: "baseline",
    calibrationDirectory: DEFAULT_CALIBRATION_DIRECTORY,
    outputDirectory: DEFAULT_OUTPUT_DIRECTORY,
    cacheDirectory: DEFAULT_CACHE_DIRECTORY,
  };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--label") options.label = text(args[++index]);
    else if (value === "--calibration-dir") options.calibrationDirectory = path.resolve(args[++index]);
    else if (value === "--output-dir") options.outputDirectory = path.resolve(args[++index]);
    else if (value === "--cache-dir") options.cacheDirectory = path.resolve(args[++index]);
    else throw new Error(`PHASE5_TUNING:UNKNOWN_ARGUMENT:${value}`);
  }
  if (!/^[a-z0-9-]+$/i.test(options.label)) throw new Error("PHASE5_TUNING:INVALID_LABEL");
  return options;
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

function decisionForVisualRow(row) {
  if (CALIBRATION_MODES.has(row.truth_mode)) {
    return { mode: row.truth_mode, sourceId: text(row.truth_source_id) || null };
  }
  if (row.visual_decision === "APPROVE_CANDIDATE") {
    return { mode: row.candidate_mode, sourceId: text(row.candidate_source_id) || null };
  }
  const modes = {
    KEEP_CURRENT_FULL: "PACKAGE_FULL",
    BETTER_RIGHT: "PACKAGE_RIGHT",
    BETTER_CENTER: "PACKAGE_CENTER",
    BETTER_FULL: "PACKAGE_FULL",
    BETTER_SAMPLE: "SAMPLE",
  };
  const mode = modes[row.visual_decision] ?? null;
  return mode ? { mode, sourceId: null } : null;
}

async function readCalibrationLabels(directory) {
  const [phase5Source, historicalSource] = await Promise.all([
    fs.readFile(path.join(directory, "phase5-review.csv"), "utf8"),
    fs.readFile(path.join(directory, "historical-control-20.csv"), "utf8"),
  ]);
  const labels = [];
  for (const [group, rows] of [
    ["EXISTING_PHASE5_VISUAL", parseCsv(phase5Source)],
    ["EXISTING_HISTORICAL_CONTROL", parseCsv(historicalSource)],
  ]) {
    for (const row of rows) {
      const truth = decisionForVisualRow(row);
      if (!truth || !CALIBRATION_MODES.has(truth.mode)) continue;
      labels.push({
        group,
        code: canonicalCode(row.product_code),
        truthMode: truth.mode,
        truthSourceId: truth.sourceId,
        visualDecision: row.visual_decision,
        visualNote: row.visual_note,
      });
    }
  }
  if (labels.filter((label) => label.group === "EXISTING_PHASE5_VISUAL").length !== 50) {
    throw new Error("PHASE5_TUNING:PHASE5_VISUAL_COUNT_MISMATCH");
  }
  if (labels.filter((label) => label.group === "EXISTING_HISTORICAL_CONTROL").length !== 20) {
    throw new Error("PHASE5_TUNING:HISTORICAL_COUNT_MISMATCH");
  }
  return labels;
}

function productionLabels() {
  return [...PRODUCTION_THUMBNAIL_DECISIONS.values()]
    .filter((decision) => CALIBRATION_MODES.has(decision.mode))
    .map((decision) => ({
      group: "PRODUCTION_EFFECTIVE",
      code: canonicalCode(decision.code),
      truthMode: decision.mode,
      truthSourceId: decision.source_id,
      visualDecision: "PRODUCTION_EFFECTIVE_DECISION",
      visualNote: decision.reason,
    }));
}

function candidateMode(candidate) {
  return ({ sample: "SAMPLE", dvd_right: "PACKAGE_RIGHT", dvd_center: "PACKAGE_CENTER", dvd_full: "PACKAGE_FULL", vertical_package: "PACKAGE_FULL" })[candidate?.type] ?? null;
}

function candidateSourceId(candidate) {
  if (candidate?.type === "sample") return `sample:${candidate.sampleIndex}`;
  return ({ dvd_right: "dvd:right", dvd_center: "dvd:center", dvd_full: "dvd:full", vertical_package: "dvd:full" })[candidate?.type] ?? null;
}

function candidateSnapshot(candidate) {
  if (!candidate) return null;
  return {
    mode: candidateMode(candidate),
    source_id: candidateSourceId(candidate),
    score: candidate.score,
    review: candidate.review,
    excluded: candidate.excluded,
    reasons: candidate.reasons,
    components: candidate.components,
    flags: candidate.flags,
    meta: candidate.meta,
    visual: candidate.visual,
  };
}

function matchesTruth(candidate, truth, { requireSource = false } = {}) {
  if (!candidate || candidate.mode !== truth.truthMode) return false;
  return !requireSource || !truth.truthSourceId || candidate.source_id === truth.truthSourceId;
}

function emptyModeMetrics() {
  return { sample_size: 0, top1_mode: 0, top1_source: 0, top2_mode: 0, top2_source: 0, wrong: 0 };
}

function summarize(evaluations, labels) {
  const evaluationByCode = new Map(evaluations.map((row) => [row.product_code, row]));
  const byMode = Object.fromEntries([...CALIBRATION_MODES].map((mode) => [mode, emptyModeMetrics()]));
  const confusion = {};
  let missing = 0;
  for (const truth of labels) {
    const evaluation = evaluationByCode.get(truth.code);
    if (!evaluation) {
      missing += 1;
      continue;
    }
    const metrics = byMode[truth.truthMode];
    metrics.sample_size += 1;
    if (matchesTruth(evaluation.top1, truth)) metrics.top1_mode += 1;
    if (matchesTruth(evaluation.top1, truth, { requireSource: true })) metrics.top1_source += 1;
    if ([evaluation.top1, evaluation.top2].some((candidate) => matchesTruth(candidate, truth))) metrics.top2_mode += 1;
    if ([evaluation.top1, evaluation.top2].some((candidate) => matchesTruth(candidate, truth, { requireSource: true }))) metrics.top2_source += 1;
    if (!matchesTruth(evaluation.top1, truth)) {
      metrics.wrong += 1;
      const key = `${truth.truthMode}->${evaluation.top1?.mode ?? "NONE"}`;
      confusion[key] = (confusion[key] ?? 0) + 1;
    }
  }
  return { total_labels: labels.length, evaluated_labels: labels.length - missing, missing, by_mode: byMode, confusion };
}

function uniqueEffectiveLabels(existingLabels) {
  const production = productionLabels();
  const labels = new Map(production.map((label) => [label.code, label]));
  for (const label of existingLabels) {
    if (!labels.has(label.code)) labels.set(label.code, label);
  }
  return { production, effective: [...labels.values()].sort((left, right) => left.code.localeCompare(right.code, "en")) };
}

async function atomicWrite(file, contents) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  await fs.writeFile(temporary, contents);
  await fs.rename(temporary, file);
}

export async function runThumbnailPhase5Calibration(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) throw new Error("PHASE5_TUNING:SUPABASE_ENV_MISSING");
  const existingLabels = await readCalibrationLabels(options.calibrationDirectory);
  const { production, effective } = uniqueEffectiveLabels(existingLabels);
  if (effective.length > 200) throw new Error(`PHASE5_TUNING:TRUTH_SET_TOO_LARGE:${effective.length}`);
  configureThumbnailCandidateV3({
    repositoryRoot: root,
    outputDirectory: options.outputDirectory,
    cacheDirectory: path.join(options.cacheDirectory, "images"),
  });
  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const videos = await fetchAll(
    db,
    "videos",
    "id,product_code,title,maker_name,series_name,label_name,genre,thumbnail_url,card_thumbnail_url,sample_images,is_published,source_name,external_product_id,created_at,source_checked_at",
    (query) => query.eq("is_published", true).order("id", { ascending: true }),
  );
  const videosByCode = new Map(videos.map((video) => [canonicalCode(video.product_code), video]));
  const evaluations = [];
  for (const [index, truth] of effective.entries()) {
    const video = videosByCode.get(truth.code);
    if (!video) continue;
    const v3Row = await decideThumbnailCandidateV3(video, {
      deduplicateSamplePairs: true,
      preferSmallSampleProxy: false,
      sampleConcurrency: 1,
      candidateLimit: null,
    });
    const record = buildPhase5CandidateRecord({ video, v3Row });
    evaluations.push({
      product_code: truth.code,
      effective_truth_mode: truth.truthMode,
      effective_truth_source_id: truth.truthSourceId,
      top1: candidateSnapshot(v3Row.candidates[0]),
      top2: candidateSnapshot(v3Row.candidates[1]),
      candidates: v3Row.candidates.map(candidateSnapshot),
      needs_review: v3Row.needs_review,
      v3_confidence: v3Row.confidence,
      phase5_classification: record.classification,
      phase5_confidence: record.confidence,
      phase5_risk: record.risk,
    });
    if ((index + 1) % 10 === 0 || index + 1 === effective.length) {
      process.stdout.write(`${JSON.stringify({ processed: index + 1, total: effective.length })}\n`);
    }
  }
  const metrics = {
    generated_at: new Date().toISOString(),
    label: options.label,
    truth_set: {
      unique_effective: effective.length,
      production_effective: production.length,
      existing_visual: 50,
      historical_control: 20,
      evaluated: evaluations.length,
    },
    production_effective: summarize(evaluations, production),
    existing_70: summarize(evaluations, existingLabels),
    effective_unique: summarize(evaluations, effective),
    class_distribution: evaluations.reduce((counts, row) => {
      counts[row.phase5_classification] = (counts[row.phase5_classification] ?? 0) + 1;
      return counts;
    }, {}),
    class_a_by_mode: evaluations.filter((row) => row.phase5_classification === "A").reduce((counts, row) => {
      const mode = row.top1?.mode ?? "NONE";
      counts[mode] = (counts[mode] ?? 0) + 1;
      return counts;
    }, {}),
  };
  await Promise.all([
    atomicWrite(path.join(options.outputDirectory, `${options.label}-metrics.json`), `${JSON.stringify(metrics, null, 2)}\n`),
    atomicWrite(path.join(options.outputDirectory, `${options.label}-truth-results.json`), `${JSON.stringify(evaluations, null, 2)}\n`),
  ]);
  process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
  return metrics;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await runThumbnailPhase5Calibration();
