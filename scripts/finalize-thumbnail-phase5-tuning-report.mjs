import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv } from "./generate-thumbnail-production-registry.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tuningDirectory = "/Users/saitoutomoya/Documents/Codex/okazudb-state/thumbnail-reviews/phase5f-tuning";
const calibrationDirectory = "/Users/saitoutomoya/Documents/Codex/okazudb-state/thumbnail-reviews/phase5f-calibration";

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function atomicWrite(file, contents) {
  const temporary = `${file}.tmp-${process.pid}`;
  await fs.writeFile(temporary, contents);
  await fs.rename(temporary, file);
}

function tally(rows, field) {
  return rows.reduce((counts, row) => {
    const key = row[field] || "NONE";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

async function directoryStats(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  let files = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const stat = await fs.stat(path.join(directory, entry.name));
    files += 1;
    bytes += stat.size;
  }
  return { files, bytes };
}

export async function finalizeThumbnailPhase5TuningReport() {
  const [calibrationSummary, sourceBaseline, tunedSource, fullSummary, beforeAfterSource, holdoutSource, tunedResults] = await Promise.all([
    readJson(path.join(calibrationDirectory, "calibration-summary.json")),
    readJson(path.join(tuningDirectory, "source-baseline-metrics.json")),
    readJson(path.join(tuningDirectory, "tuned-metrics.json")),
    readJson(path.join(tuningDirectory, "full-run", "candidate-summary.json")),
    fs.readFile(path.join(tuningDirectory, "before-after-70.csv"), "utf8"),
    fs.readFile(path.join(tuningDirectory, "holdout-30.csv"), "utf8"),
    readJson(path.join(tuningDirectory, "tuned-truth-results.json")),
  ]);
  const beforeAfter = parseCsv(beforeAfterSource);
  const holdout = parseCsv(holdoutSource);
  const phase5Rows = beforeAfter.filter((row) => row.group !== "HISTORICAL_CONTROL");
  const byBeforeMode = {};
  for (const mode of ["SAMPLE", "PACKAGE_RIGHT", "PACKAGE_CENTER", "PACKAGE_FULL"]) {
    const rows = phase5Rows.filter((row) => row.before_mode === mode);
    byBeforeMode[mode] = {
      sample_size: rows.length,
      before_correct: rows.filter((row) => row.before_visual_result === "APPROVE_CANDIDATE").length,
      after_correct: rows.filter((row) => row.after_result !== "WRONG").length,
    };
  }
  const holdoutByMode = {};
  for (const mode of ["SAMPLE", "PACKAGE_RIGHT", "PACKAGE_CENTER", "PACKAGE_FULL"]) {
    const rows = holdout.filter((row) => row.candidate_mode === mode);
    holdoutByMode[mode] = {
      sample_size: rows.length,
      correct: rows.filter((row) => row.visual_result === "CORRECT").length,
      acceptable: rows.filter((row) => row.visual_result === "ACCEPTABLE").length,
      wrong: rows.filter((row) => row.visual_result === "WRONG").length,
    };
  }
  const classACalibration = tunedResults.filter((row) => row.phase5_classification === "A");
  const classACorrect = classACalibration.filter((row) => row.top1?.mode === row.effective_truth_mode).length;
  const baseline = {
    generated_at: new Date().toISOString(),
    phase: "Phase 5F-D",
    baseline_commit: "c5087228060d39ba8b0277af2e617276f32f9d5d",
    current_logic_phase5f_c: {
      phase5_visual_by_candidate_mode: calibrationSummary.by_candidate_mode,
      historical_control: calibrationSummary.historical_control,
      class_a: calibrationSummary.class_a,
      phase5_distribution: {
        modes: { SAMPLE: 59, PACKAGE_RIGHT: 521, PACKAGE_CENTER: 1181, PACKAGE_FULL: 356 },
        confidence: { high: 132, medium: 1682, low: 303 },
        classification: { A: 132, B: 1682, C: 303 },
      },
    },
    exact_source_truth_baseline: sourceBaseline,
    proxy_excluded_from_tuned_truth_features: true,
  };
  const tuned = {
    ...tunedSource,
    iterations: 2,
    existing_phase5_50_by_original_candidate_mode: byBeforeMode,
    class_a_validation: {
      phase5_total: fullSummary.summary.classification.A ?? 0,
      calibration_checked: classACalibration.length,
      calibration_correct: classACorrect,
      calibration_precision: classACalibration.length ? classACorrect / classACalibration.length : null,
      holdout_checked: holdout.filter((row) => row.classification === "A").length,
      holdout_precision: null,
      auto_safe_conclusion: "INSUFFICIENT_INDEPENDENT_HOLDOUT; REVIEW_ONLY",
    },
    phase5_distribution_after: fullSummary.summary,
    holdout_30: {
      total: holdout.length,
      by_mode: holdoutByMode,
      overall: tally(holdout, "visual_result"),
    },
    production_isolation: {
      approved_rows: 0,
      registry_diff: 0,
      db_write: 0,
      production_display_change: 0,
    },
    preview_assets: await directoryStats(path.join(tuningDirectory, "previews")),
    verdict: "THUMBNAIL_REVIEW_ONLY_PIPELINE_READY",
  };
  await Promise.all([
    atomicWrite(path.join(tuningDirectory, "baseline-metrics.json"), `${JSON.stringify(baseline, null, 2)}\n`),
    atomicWrite(path.join(tuningDirectory, "tuned-metrics.json"), `${JSON.stringify(tuned, null, 2)}\n`),
  ]);
  process.stdout.write(`${JSON.stringify({ baseline, tuned }, null, 2)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await finalizeThumbnailPhase5TuningReport();
