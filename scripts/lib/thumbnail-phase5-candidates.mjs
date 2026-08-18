import crypto from "node:crypto";

export const PHASE5_CANDIDATE_HEADERS = Object.freeze([
  "product_code",
  "video_id",
  "external_product_id",
  "created_at",
  "source_checked_at",
  "maker_name",
  "series_name",
  "current_url",
  "current_mode",
  "current_source_id",
  "current_decision_source",
  "candidate_mode",
  "candidate_source_id",
  "candidate_url",
  "candidate_output_preview",
  "candidate_source_hash",
  "candidate_output_hash",
  "candidate_provenance",
  "candidate_reasons",
  "risk_flags",
  "sample_index",
  "crop_left",
  "crop_width",
  "source_width",
  "source_height",
  "score",
  "runner_up_mode",
  "runner_up_source_id",
  "runner_up_score",
  "score_delta",
  "confidence",
  "risk",
  "classification",
  "apply",
  "review_status",
]);

const MODE_BY_V3_TYPE = Object.freeze({
  sample: "SAMPLE",
  dvd_right: "PACKAGE_RIGHT",
  dvd_center: "PACKAGE_CENTER",
  dvd_full: "PACKAGE_FULL",
  vertical_package: "PACKAGE_FULL",
});

const SOURCE_ID_BY_V3_TYPE = Object.freeze({
  dvd_right: "dvd:right",
  dvd_center: "dvd:center",
  dvd_full: "dvd:full",
  vertical_package: "dvd:full",
});

const SOURCE_ID_PATTERNS = Object.freeze({
  SAMPLE: /^sample:[1-9]\d*$/,
  PACKAGE_RIGHT: /^dvd:right$/,
  PACKAGE_CENTER: /^dvd:center$/,
  PACKAGE_FULL: /^dvd:full$/,
});

const SHA256 = /^[a-f0-9]{64}$/;

const text = (value) => typeof value === "string" && value.trim() ? value.trim() : "";

export function isPhase5ThumbnailCandidatePending({
  video,
  hasProductionDecision = false,
  hasPhase4BDecision = false,
  hasLegacyOverride = false,
  isProtectedExclusion = false,
}) {
  return Boolean(
    video?.is_published === true
      && video?.source_name === "FANZA Webサービス"
      && text(video?.external_product_id)
      && (text(video?.card_thumbnail_url) || text(video?.thumbnail_url))
      && !hasProductionDecision
      && !hasPhase4BDecision
      && !hasLegacyOverride
      && !isProtectedExclusion,
  );
}

export function csvValue(value) {
  if (value === null || value === undefined) return "";
  const raw = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(raw) ? `"${raw.replaceAll('"', '""')}"` : raw;
}

export function serializeCandidateCsv(records) {
  return `${[
    PHASE5_CANDIDATE_HEADERS.join(","),
    ...records.map((record) => PHASE5_CANDIDATE_HEADERS
      .map((field) => csvValue(record[field]))
      .join(",")),
  ].join("\n")}\n`;
}

export function phase5CandidateDigest(records) {
  const stable = records.map((record) => Object.fromEntries(
    PHASE5_CANDIDATE_HEADERS
      .filter((field) => field !== "created_at" && field !== "source_checked_at")
      .map((field) => [field, record[field]]),
  ));
  return crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function hasCandidateRisk(candidate) {
  return Boolean(
    candidate?.excluded
      || candidate?.review
      || candidate?.flags?.bodyPartOrClose
      || candidate?.flags?.faceOnlyLike
      || candidate?.flags?.plainScene
      || candidate?.flags?.cropLooksCut
      || candidate?.components?.bodyPart > 0
      || candidate?.components?.faceOnly > 0
      || candidate?.components?.scenePhoto >= 40
      || candidate?.reasons?.some((reason) =>
        /body_part|face_only|plain_scene|person_or_text_cut|low_resolution/.test(reason)),
  );
}

function sourceId(candidate) {
  if (candidate?.type === "sample") {
    if (!Number.isInteger(candidate.sampleIndex) || candidate.sampleIndex < 1) return null;
    return `sample:${candidate.sampleIndex}`;
  }
  return SOURCE_ID_BY_V3_TYPE[candidate?.type] ?? null;
}

function candidateMode(candidate) {
  return MODE_BY_V3_TYPE[candidate?.type] ?? null;
}

function outputPreview(candidate, code) {
  if (candidate?.type === "dvd_right") return `generated:${code}-auto-right.jpg`;
  if (candidate?.type === "dvd_center") return `generated:${code}-auto-center.jpg`;
  return text(candidate?.url);
}

function classificationFor(row, best, runnerUp) {
  if (!best) return { classification: "C", confidence: "none", risk: "reject" };
  const delta = runnerUp ? best.score - runnerUp.score : null;
  if (hasCandidateRisk(best) || best.score < 78) {
    return { classification: "C", confidence: "low", risk: "reject" };
  }
  if (
    best.type === "dvd_center"
      || (delta !== null && delta < 12)
      || row.needs_review
  ) {
    return { classification: "B", confidence: "medium", risk: "review" };
  }
  return { classification: "A", confidence: "high", risk: "safe" };
}

function materializedCandidate(candidate, code) {
  if (!candidate) return null;
  const mode = candidateMode(candidate);
  const id = sourceId(candidate);
  const url = text(candidate.sourceUrl || candidate.url);
  const sourceHash = text(candidate.sourceHash).toLowerCase();
  const outputHash = text(candidate.outputHash).toLowerCase();
  if (!mode || !id || !url || !SHA256.test(sourceHash) || !SHA256.test(outputHash)) {
    return null;
  }
  return {
    mode,
    source_id: id,
    url,
    output_preview: outputPreview(candidate, code),
    source_hash: sourceHash,
    output_hash: outputHash,
    sample_index: candidate.sampleIndex ?? null,
    crop_left: candidate.cropLeft ?? null,
    crop_width: candidate.cropWidth ?? null,
    source_width: candidate.sourceWidth ?? candidate.meta?.width ?? null,
    source_height: candidate.sourceHeight ?? candidate.meta?.height ?? null,
    score: candidate.score,
    reasons: candidate.reasons ?? [],
    flags: candidate.flags ?? {},
  };
}

export function buildPhase5CandidateRecord({ video, sourceProduct = null, v3Row }) {
  const ranked = (v3Row?.candidates ?? [])
    .map((candidate) => ({ raw: candidate, materialized: materializedCandidate(candidate, video.product_code) }))
    .filter((entry) => entry.materialized);
  const bestEntry = ranked[0] ?? null;
  const runnerEntry = ranked[1] ?? null;
  const best = bestEntry?.materialized ?? null;
  const runner = runnerEntry?.materialized ?? null;
  const gate = classificationFor(v3Row, bestEntry?.raw, runnerEntry?.raw);
  const record = {
    product_code: video.product_code,
    video_id: video.id,
    external_product_id: video.external_product_id ?? sourceProduct?.external_product_id ?? "",
    created_at: video.created_at ?? "",
    source_checked_at: video.source_checked_at ?? "",
    maker_name: video.maker_name ?? "",
    series_name: video.series_name ?? "",
    current_url: video.card_thumbnail_url ?? video.thumbnail_url ?? "",
    current_mode: "LEGACY_UNCLASSIFIED",
    current_source_id: video.card_thumbnail_url ? "videos.card_thumbnail_url" : "videos.thumbnail_url",
    current_decision_source: "db_url_fallback",
    candidate_mode: best?.mode ?? "",
    candidate_source_id: best?.source_id ?? "",
    candidate_url: best?.url ?? "",
    candidate_output_preview: best?.output_preview ?? "",
    candidate_source_hash: best?.source_hash ?? "",
    candidate_output_hash: best?.output_hash ?? "",
    candidate_provenance: best ? JSON.stringify({
      source: "dry-run-card-thumbnail-v3-added-only.mjs",
      source_product_id: sourceProduct?.id ?? null,
      source_product_import_job_id: sourceProduct?.import_job_id ?? null,
      normalized_data_present: Boolean(sourceProduct?.normalized_data),
      package_crop_is_preview_only: ["PACKAGE_RIGHT", "PACKAGE_CENTER"].includes(best.mode),
    }) : "",
    candidate_reasons: best ? JSON.stringify(best.reasons) : "[]",
    risk_flags: best ? JSON.stringify(best.flags) : "{}",
    sample_index: best?.sample_index ?? "",
    crop_left: best?.crop_left ?? "",
    crop_width: best?.crop_width ?? "",
    source_width: best?.source_width ?? "",
    source_height: best?.source_height ?? "",
    score: best?.score ?? "",
    runner_up_mode: runner?.mode ?? "",
    runner_up_source_id: runner?.source_id ?? "",
    runner_up_score: runner?.score ?? "",
    score_delta: best && runner ? best.score - runner.score : "",
    confidence: gate.confidence,
    risk: gate.risk,
    classification: gate.classification,
    apply: false,
    review_status: "PENDING_REVIEW",
  };
  assertPhase5CandidateRecord(record);
  return Object.freeze(record);
}

export function assertPhase5CandidateRecord(record) {
  for (const field of ["product_code", "video_id", "current_url", "current_source_id", "review_status"]) {
    if (!text(record[field])) throw new Error(`PHASE5_CANDIDATE:MISSING_${field.toUpperCase()}`);
  }
  if (record.apply !== false || record.review_status !== "PENDING_REVIEW") {
    throw new Error(`PHASE5_CANDIDATE:${record.product_code}:MUST_BE_PENDING_APPLY_FALSE`);
  }
  if (!record.candidate_mode) return record;
  const pattern = SOURCE_ID_PATTERNS[record.candidate_mode];
  if (!pattern?.test(record.candidate_source_id)) {
    throw new Error(`PHASE5_CANDIDATE:${record.product_code}:SOURCE_ID_CONTRACT`);
  }
  if (!SHA256.test(record.candidate_source_hash) || !SHA256.test(record.candidate_output_hash)) {
    throw new Error(`PHASE5_CANDIDATE:${record.product_code}:HASH_CONTRACT`);
  }
  if (record.candidate_mode === "SAMPLE") {
    const index = Number(/^sample:(\d+)$/.exec(record.candidate_source_id)?.[1]);
    if (index !== Number(record.sample_index)) {
      throw new Error(`PHASE5_CANDIDATE:${record.product_code}:SAMPLE_INDEX_MISMATCH`);
    }
  }
  if (["PACKAGE_RIGHT", "PACKAGE_CENTER"].includes(record.candidate_mode)) {
    if (!Number.isInteger(Number(record.crop_left)) || Number(record.crop_left) < 0) {
      throw new Error(`PHASE5_CANDIDATE:${record.product_code}:CROP_LEFT_CONTRACT`);
    }
    if (!Number.isInteger(Number(record.crop_width)) || Number(record.crop_width) <= 0) {
      throw new Error(`PHASE5_CANDIDATE:${record.product_code}:CROP_WIDTH_CONTRACT`);
    }
  }
  return record;
}

export function selectProductionEligiblePhase5Records(records) {
  return records.filter((record) =>
    record.apply === true
      && record.review_status === "HUMAN_APPROVED"
      && text(record.approved_by)
      && text(record.approved_at)
      && text(record.reason),
  );
}

export function candidateSummary(records) {
  const countBy = (field) => records.reduce((counts, record) => {
    const key = text(record[field]) || "NONE";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
  return Object.freeze({
    total: records.length,
    candidate_generated: records.filter((record) => record.candidate_mode).length,
    no_candidate: records.filter((record) => !record.candidate_mode).length,
    recommended_modes: countBy("candidate_mode"),
    confidence: countBy("confidence"),
    risk: countBy("risk"),
    classification: countBy("classification"),
    apply_true: records.filter((record) => record.apply === true).length,
  });
}

export function selectStratifiedCanary(records, targets = Object.freeze({
  SAMPLE: 10,
  PACKAGE_RIGHT: 10,
  PACKAGE_CENTER: 5,
  PACKAGE_FULL: 5,
})) {
  const selected = [];
  const usedCodes = new Set();
  const usedGroups = new Set();
  for (const [mode, target] of Object.entries(targets)) {
    const candidates = records
      .filter((record) => record.candidate_mode === mode)
      .sort((left, right) => {
        const confidence = { high: 0, medium: 1, low: 2, none: 3 };
        return (confidence[left.confidence] ?? 4) - (confidence[right.confidence] ?? 4)
          || Number(right.score || -999) - Number(left.score || -999)
          || left.created_at.localeCompare(right.created_at)
          || left.product_code.localeCompare(right.product_code, "en");
      });
    const picked = [];
    for (const record of candidates) {
      const group = `${record.maker_name}\u0000${record.series_name}`;
      if (usedGroups.has(group) && picked.length < Math.ceil(target / 2)) continue;
      if (usedCodes.has(record.product_code)) continue;
      picked.push(record);
      usedCodes.add(record.product_code);
      usedGroups.add(group);
      if (picked.length === target) break;
    }
    if (picked.length < target) {
      for (const record of candidates) {
        if (usedCodes.has(record.product_code)) continue;
        picked.push(record);
        usedCodes.add(record.product_code);
        if (picked.length === target) break;
      }
    }
    selected.push(...picked);
  }
  return Object.freeze(selected);
}
