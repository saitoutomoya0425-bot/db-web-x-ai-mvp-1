import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { canonicalizeProductCodeValue } from "../src/lib/fanza/normalize.ts";
import { parseCsv } from "./generate-thumbnail-production-registry.mjs";
import { configureThumbnailCandidateV3, decideThumbnailCandidateV3 } from "./dry-run-card-thumbnail-v3-added-only.mjs";
import { csvValue } from "./lib/thumbnail-phase5-candidates.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TUNING_DIRECTORY = "/Users/saitoutomoya/Documents/Codex/okazudb-state/thumbnail-reviews/phase5f-tuning";
const CALIBRATION_DIRECTORY = "/Users/saitoutomoya/Documents/Codex/okazudb-state/thumbnail-reviews/phase5f-calibration";
const CACHE_DIRECTORY = "/private/tmp/db-web-x-ai-mvp-1-phase5f-tuning-cache";
const REVIEW_SHEET_DIRECTORY = "/private/tmp/db-web-x-ai-mvp-1-phase5f-holdout-sheets";
const HOLDOUT_TARGETS = Object.freeze({ SAMPLE: 8, PACKAGE_RIGHT: 8, PACKAGE_CENTER: 7, PACKAGE_FULL: 7 });
const HOLDOUT_VISUAL_LABELS = new Map(Object.entries({
  H_021PTES00027: ["CORRECT", "Promotional portrait is clearer and more representative than the current scene."],
  H_1454BDSR51201: ["WRONG", "Proposed generic scene loses the current package context."],
  H_1454MCSR52303: ["ACCEPTABLE", "Proposed scene is comparable to current, but not a clear improvement."],
  "1SDNM00557": ["CORRECT", "Portrait-led promotional sample is clearer in the card."],
  H_1651Y00415: ["CORRECT", "Proposed portrait is clearer than the current collage."],
  "1IENEE81003": ["CORRECT", "Proposed frame shows the subject and context more clearly."],
  "1IENEE89304": ["CORRECT", "Clean portrait is more representative than the current scene."],
  DVRT07801: ["CORRECT", "Promotional sample preserves identity and product context."],
  ALDN00604: ["CORRECT", "RIGHT keeps the title and primary subject at card scale."],
  "1JERA00044": ["CORRECT", "RIGHT is clearer than FULL while preserving key information."],
  "1NAMH00073": ["CORRECT", "RIGHT preserves the title and primary portrait."],
  SAVR01169: ["CORRECT", "RIGHT gives a clear portrait and keeps useful text."],
  DDOB00142: ["CORRECT", "RIGHT improves card legibility without losing the main context."],
  VEMA00264: ["CORRECT", "RIGHT preserves the primary portrait and title."],
  PARATHD04512: ["CORRECT", "RIGHT is the clearest representative crop."],
  SAME00250: ["CORRECT", "RIGHT preserves the primary portrait and title."],
  "2DFDM00077": ["CORRECT", "CENTER preserves title and representative package context."],
  H_1240MILK00302: ["CORRECT", "CENTER balances montage context and the primary subject."],
  JUR00831: ["ACCEPTABLE", "CENTER retains more context; RIGHT is also viable."],
  FJIN00160: ["ACCEPTABLE", "CENTER is usable, though RIGHT gives a cleaner portrait."],
  MUDR00394: ["WRONG", "CENTER cuts the primary face; RIGHT is clearly better."],
  LULU00451: ["WRONG", "CENTER loses too much of the primary subject; RIGHT is better."],
  ROE00560: ["WRONG", "CENTER cuts the primary portrait; RIGHT is better."],
  H_1489J9900778A: ["CORRECT", "FULL matches current and preserves the complete image."],
  H_1454SPAR00503: ["CORRECT", "FULL matches current and preserves the complete package."],
  H_1787MCSR06003: ["CORRECT", "FULL matches current and preserves the complete package."],
  H_1454BDSR55901: ["CORRECT", "FULL matches current and preserves the complete composition."],
  H_1454SPAR00601: ["CORRECT", "FULL matches current and preserves the complete package."],
  "1IENFA45501": ["CORRECT", "FULL matches current and preserves the montage."],
  YRNKMTNDVAJ00728A: ["CORRECT", "FULL matches current and preserves the complete image."],
}));
const MODE_BY_TYPE = Object.freeze({
  sample: "SAMPLE",
  dvd_right: "PACKAGE_RIGHT",
  dvd_center: "PACKAGE_CENTER",
  dvd_full: "PACKAGE_FULL",
  vertical_package: "PACKAGE_FULL",
});

const text = (value) => typeof value === "string" && value.trim() ? value.trim() : "";
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const stableKey = (value) => sha256(value);

function canonicalCode(value) {
  const result = canonicalizeProductCodeValue(value);
  return result.canonical && !result.rejected ? result.canonical : text(value).toUpperCase();
}

function sourceId(candidate) {
  if (candidate?.type === "sample") return `sample:${candidate.sampleIndex}`;
  return ({ dvd_right: "dvd:right", dvd_center: "dvd:center", dvd_full: "dvd:full", vertical_package: "dvd:full" })[candidate?.type] ?? "";
}

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

async function calibrationCodes() {
  const [phase5, historical] = await Promise.all([
    fs.readFile(path.join(CALIBRATION_DIRECTORY, "phase5-review.csv"), "utf8"),
    fs.readFile(path.join(CALIBRATION_DIRECTORY, "historical-control-20.csv"), "utf8"),
  ]);
  return new Set([...parseCsv(phase5), ...parseCsv(historical)].map((row) => canonicalCode(row.product_code)));
}

function selectHoldout(inventory, excluded) {
  const selected = [];
  const usedGroups = new Set();
  for (const [mode, target] of Object.entries(HOLDOUT_TARGETS)) {
    const candidates = inventory
      .filter((row) => row.candidate_mode === mode && !excluded.has(canonicalCode(row.product_code)))
      .sort((left, right) => {
        if (mode === "PACKAGE_FULL" && left.classification !== right.classification) {
          if (left.classification === "A") return -1;
          if (right.classification === "A") return 1;
        }
        return stableKey(left.product_code).localeCompare(stableKey(right.product_code), "en");
      });
    const picked = [];
    for (const row of candidates) {
      const group = `${row.maker_name}\u0000${row.series_name}`;
      if (usedGroups.has(group)) continue;
      picked.push(row);
      usedGroups.add(group);
      if (picked.length === target) break;
    }
    for (const row of candidates) {
      if (picked.length === target) break;
      if (picked.some((entry) => entry.product_code === row.product_code)) continue;
      picked.push(row);
    }
    if (picked.length !== target) throw new Error(`PHASE5_TUNING:HOLDOUT_SHORT:${mode}:${picked.length}:${target}`);
    selected.push(...picked);
  }
  if (new Set(selected.map((row) => row.product_code)).size !== 30) throw new Error("PHASE5_TUNING:HOLDOUT_DUPLICATE");
  return selected;
}

function cacheFile(url) {
  const parsed = new URL(url);
  const ext = path.extname(parsed.pathname) || ".jpg";
  return path.join(CACHE_DIRECTORY, "images", `${crypto.createHash("sha1").update(url).digest("hex")}${ext}`);
}

async function sourceBuffer(url) {
  if (url.startsWith("/")) return fs.readFile(path.join(root, "public", url.replace(/^\//, "")));
  return fs.readFile(cacheFile(url));
}

async function previewBuffer(candidate, fallbackUrl = null) {
  if (!candidate) {
    const source = await sourceBuffer(fallbackUrl);
    return sharp(source).resize({ width: 210, height: 300, fit: "contain", background: "#e5e7eb" }).png().toBuffer();
  }
  const source = await sourceBuffer(candidate.sourceUrl || candidate.url);
  let image = sharp(source);
  if (candidate.type === "dvd_right" || candidate.type === "dvd_center") {
    image = image.extract({
      left: candidate.cropLeft,
      top: 0,
      width: candidate.cropWidth,
      height: candidate.sourceHeight,
    });
  }
  return image.resize({ width: 210, height: 300, fit: "contain", background: "#e5e7eb" }).png().toBuffer();
}

async function writePreview(buffer, code, label) {
  const digest = sha256(buffer).slice(0, 16);
  const file = `${code}-${label}-${digest}.png`;
  const output = path.join(TUNING_DIRECTORY, "previews", file);
  try {
    await fs.access(output);
  } catch {
    await atomicWrite(output, buffer);
  }
  return `previews/${file}`;
}

function figure(label, file, candidate, note = "") {
  return `<figure><div class="tag">${label}</div><img src="${file}" loading="lazy"><figcaption>${candidate ? `${MODE_BY_TYPE[candidate.type]} / ${sourceId(candidate)} / score ${candidate.score}` : "CURRENT"}<br>${note}</figcaption></figure>`;
}

function reviewHtml(rows) {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Phase 5F tuning holdout 30</title><style>body{font-family:-apple-system,sans-serif;background:#f3f4f6;margin:18px;color:#111827}article{background:white;border:1px solid #d1d5db;border-radius:12px;padding:14px;margin:0 0 16px}h2{margin:0 0 8px;font-size:18px}.grid{display:grid;grid-template-columns:repeat(3,minmax(180px,230px));gap:12px}figure{margin:0}.tag{font-weight:800;font-size:15px;margin-bottom:4px}img{width:210px;height:300px;object-fit:contain;background:#e5e7eb}figcaption{font-size:12px;line-height:1.45;overflow-wrap:anywhere}.meta{font-size:12px}@media(max-width:760px){.grid{grid-template-columns:1fr 1fr}}</style></head><body><h1>Phase 5F tuning holdout 30</h1><p>tuning終了後の一回限り評価。全件apply=false。</p>${rows.map((row) => `<article><h2>${row.product_code} — ${row.candidate_mode} / class ${row.classification}</h2><div class="grid">${figure("CURRENT", row.current_preview, null, row.current_url)}${figure("PROPOSED", row.proposed_preview, row.best, row.best.reasons.join(", "))}${figure("RUNNER-UP", row.runner_preview, row.runner, row.runner?.reasons?.join(", ") ?? "none")}</div><p class="meta">score delta ${row.score_delta} / confidence ${row.confidence} / risk ${row.risk} / visual result: ____________________</p></article>`).join("\n")}</body></html>`;
}

function visualTruth(row) {
  if (text(row.truth_mode)) return { mode: row.truth_mode, sourceId: text(row.truth_source_id) };
  if (row.visual_decision === "APPROVE_CANDIDATE") return { mode: row.candidate_mode, sourceId: row.candidate_source_id };
  return {
    mode: ({ KEEP_CURRENT_FULL: "PACKAGE_FULL", BETTER_SAMPLE: "SAMPLE", BETTER_RIGHT: "PACKAGE_RIGHT", BETTER_CENTER: "PACKAGE_CENTER", BETTER_FULL: "PACKAGE_FULL" })[row.visual_decision] ?? "",
    sourceId: "",
  };
}

async function beforeAfter70Csv() {
  const [phase5, historical, tunedSource] = await Promise.all([
    fs.readFile(path.join(CALIBRATION_DIRECTORY, "phase5-review.csv"), "utf8"),
    fs.readFile(path.join(CALIBRATION_DIRECTORY, "historical-control-20.csv"), "utf8"),
    fs.readFile(path.join(TUNING_DIRECTORY, "tuned-truth-results.json"), "utf8"),
  ]);
  const tuned = new Map(JSON.parse(tunedSource).map((row) => [row.product_code, row]));
  const records = [...parseCsv(phase5), ...parseCsv(historical)].map((row) => {
    const truth = visualTruth(row);
    const after = tuned.get(canonicalCode(row.product_code));
    const afterModeCorrect = after?.top1?.mode === truth.mode;
    const afterSourceCorrect = !truth.sourceId || after?.top1?.source_id === truth.sourceId;
    return {
      group: row.group,
      product_code: row.product_code,
      before_mode: row.candidate_mode,
      before_source_id: row.candidate_source_id,
      before_score: row.candidate_score,
      after_mode: after?.top1?.mode ?? "",
      after_source_id: after?.top1?.source_id ?? "",
      after_score: after?.top1?.score ?? "",
      truth_mode: truth.mode,
      truth_source_id: truth.sourceId,
      before_visual_result: row.visual_decision,
      after_result: afterModeCorrect && afterSourceCorrect ? "EXACT" : afterModeCorrect ? "MODE_MATCH" : "WRONG",
    };
  });
  const fields = Object.keys(records[0]);
  return `${[fields.join(","), ...records.map((record) => fields.map((field) => csvValue(record[field])).join(","))].join("\n")}\n`;
}

async function reviewSheets(rows) {
  await fs.mkdir(REVIEW_SHEET_DIRECTORY, { recursive: true });
  const files = [];
  for (let page = 0; page < Math.ceil(rows.length / 5); page += 1) {
    const subset = rows.slice(page * 5, page * 5 + 5);
    const composites = [];
    for (const [index, row] of subset.entries()) {
      const y = 55 + index * 320;
      const title = Buffer.from(`<svg width="900" height="38"><rect width="900" height="38" fill="#fff"/><text x="8" y="25" font-family="Arial" font-size="18" font-weight="700" fill="#111">${row.product_code}  ${row.candidate_mode}  class ${row.classification}</text></svg>`);
      composites.push({ input: title, left: 10, top: y - 38 });
      for (const [column, file] of [row.current_preview, row.proposed_preview, row.runner_preview].entries()) {
        composites.push({ input: path.join(TUNING_DIRECTORY, file), left: 20 + column * 290, top: y });
      }
      const labels = Buffer.from(`<svg width="870" height="22"><rect width="870" height="22" fill="#fff"/><text x="60" y="17" font-family="Arial" font-size="14">CURRENT</text><text x="350" y="17" font-family="Arial" font-size="14">PROPOSED ${sourceId(row.best)}</text><text x="640" y="17" font-family="Arial" font-size="14">RUNNER ${sourceId(row.runner)}</text></svg>`);
      composites.push({ input: labels, left: 10, top: y + 297 });
    }
    const file = path.join(REVIEW_SHEET_DIRECTORY, `holdout-${String(page + 1).padStart(2, "0")}.png`);
    await sharp({ create: { width: 900, height: 1620, channels: 3, background: "#ffffff" } }).composite(composites).png().toFile(file);
    files.push(file);
  }
  return files;
}

export async function generateThumbnailPhase5TuningReview() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) throw new Error("PHASE5_TUNING:SUPABASE_ENV_MISSING");
  const inventory = parseCsv(await fs.readFile(path.join(TUNING_DIRECTORY, "full-run", "candidate-inventory.csv"), "utf8"));
  const selected = selectHoldout(inventory, await calibrationCodes());
  configureThumbnailCandidateV3({ repositoryRoot: root, outputDirectory: TUNING_DIRECTORY, cacheDirectory: path.join(CACHE_DIRECTORY, "images") });
  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const videos = await fetchAll(db, "videos", "product_code,title,maker_name,series_name,label_name,genre,thumbnail_url,card_thumbnail_url,sample_images,is_published", (query) => query.eq("is_published", true).order("id", { ascending: true }));
  const videosByCode = new Map(videos.map((video) => [canonicalCode(video.product_code), video]));
  const rows = [];
  for (const record of selected) {
    const video = videosByCode.get(canonicalCode(record.product_code));
    if (!video) throw new Error(`PHASE5_TUNING:HOLDOUT_VIDEO_MISSING:${record.product_code}`);
    const v3 = await decideThumbnailCandidateV3(video, { deduplicateSamplePairs: true, preferSmallSampleProxy: false, sampleConcurrency: 1 });
    const best = v3.candidates[0];
    const runner = v3.candidates[1] ?? null;
    if (MODE_BY_TYPE[best?.type] !== record.candidate_mode || sourceId(best) !== record.candidate_source_id) {
      throw new Error(`PHASE5_TUNING:HOLDOUT_REPRODUCIBILITY:${record.product_code}`);
    }
    const [currentPreview, proposedPreview, runnerPreview] = await Promise.all([
      writePreview(await previewBuffer(null, video.card_thumbnail_url || video.thumbnail_url), record.product_code, "current"),
      writePreview(await previewBuffer(best), record.product_code, "proposed"),
      runner ? writePreview(await previewBuffer(runner), record.product_code, "runner") : Promise.resolve(""),
    ]);
    const [visualResult, visualNote] = HOLDOUT_VISUAL_LABELS.get(record.product_code) ?? ["PENDING_ONE_TIME_REVIEW", ""];
    rows.push({
      ...record,
      best,
      runner,
      current_preview: currentPreview,
      proposed_preview: proposedPreview,
      runner_preview: runnerPreview,
      score_delta: runner ? best.score - runner.score : "",
      visual_result: visualResult,
      visual_note: visualNote,
    });
  }
  const fields = ["product_code", "candidate_mode", "candidate_source_id", "score", "runner_up_mode", "runner_up_source_id", "runner_up_score", "score_delta", "confidence", "risk", "classification", "current_url", "candidate_url", "current_preview", "proposed_preview", "runner_preview", "visual_result", "visual_note"];
  const csv = `${[fields.join(","), ...rows.map((row) => fields.map((field) => csvValue(row[field])).join(","))].join("\n")}\n`;
  const sheets = await reviewSheets(rows);
  await Promise.all([
    atomicWrite(path.join(TUNING_DIRECTORY, "holdout-30.csv"), csv),
    atomicWrite(path.join(TUNING_DIRECTORY, "contact-sheet-holdout.html"), reviewHtml(rows)),
    atomicWrite(path.join(TUNING_DIRECTORY, "before-after-70.csv"), await beforeAfter70Csv()),
    fs.copyFile(path.join(TUNING_DIRECTORY, "full-run", "candidate-summary.json"), path.join(TUNING_DIRECTORY, "candidate-summary-after.json")),
  ]);
  process.stdout.write(`${JSON.stringify({ holdout: rows.map((row) => row.product_code), by_mode: HOLDOUT_TARGETS, sheets }, null, 2)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await generateThumbnailPhase5TuningReview();
