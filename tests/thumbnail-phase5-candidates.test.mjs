import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { generatePhase5ReviewedSource } from "../scripts/generate-thumbnail-phase5-reviewed-decisions.mjs";
import {
  buildPhase5CandidateRecord,
  candidateSummary,
  isPhase5ThumbnailCandidatePending,
  phase5CandidateDigest,
  selectProductionEligiblePhase5Records,
  selectStratifiedCanary,
} from "../scripts/lib/thumbnail-phase5-candidates.mjs";
import {
  classifyThumbnailCandidate,
  FULL_RIGHT_REVIEW_GAP,
} from "../scripts/lib/thumbnail-candidate-classification.mjs";
import {
  fetchRowsByExactValues,
  loadExactHandoff,
  validateExactScopeRows,
} from "../scripts/generate-thumbnail-phase5-candidates.mjs";
import {
  configureThumbnailCandidateV3,
  deduplicatedSampleSourceIndices,
  decideThumbnailCandidateV3,
  getThumbnailCandidateV3FetchStats,
} from "../scripts/dry-run-card-thumbnail-v3-added-only.mjs";
import {
  applyStageDecision,
  parseAdaptiveReviewArgs,
  selectAdaptiveStageCodes,
  selectEvenlyDistributedIndices,
  selectInterleavedIndices,
} from "../scripts/review-thumbnail-scoped-adaptive.mjs";
import { PHASE4B_LEGACY_THUMBNAIL_DECISIONS } from "../src/lib/thumbnail/phase4b-legacy-registry.ts";
import {
  getProductionThumbnailDecision,
  PRODUCTION_THUMBNAIL_DECISIONS,
} from "../src/lib/thumbnail/production-registry.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const video = (overrides = {}) => ({
  id: "video-phase5-1",
  product_code: "PHASE500001",
  title: "Phase 5 test",
  maker_name: "maker-1",
  series_name: "series-1",
  thumbnail_url: "https://pics.dmm.co.jp/digital/video/phase500001/phase500001pl.jpg",
  card_thumbnail_url: "https://pics.dmm.co.jp/digital/video/phase500001/phase500001pl.jpg",
  sample_images: [
    "https://pics.dmm.co.jp/digital/video/phase500001/phase500001jp-1.jpg",
  ],
  is_published: true,
  source_name: "FANZA Webサービス",
  external_product_id: "phase500001",
  created_at: "2026-08-11T00:00:00.000Z",
  source_checked_at: "2026-08-11T00:00:00.000Z",
  ...overrides,
});

const v3Candidate = (overrides = {}) => ({
  type: "sample",
  url: "https://pics.dmm.co.jp/digital/video/phase500001/phase500001jp-1.jpg",
  sourceUrl: "https://pics.dmm.co.jp/digital/video/phase500001/phase500001jp-1.jpg",
  sourceHash: HASH_A,
  outputHash: HASH_A,
  sampleIndex: 1,
  score: 120,
  excluded: false,
  review: false,
  reasons: ["strong_explanation_power"],
  flags: {},
  components: {},
  meta: { width: 800, height: 450 },
  ...overrides,
});

const row = (candidates, overrides = {}) => ({
  candidates,
  needs_review: false,
  ...overrides,
});

const membership = "6".repeat(64);

test("exact handoff is fail-closed for count, duplicates, missing fields, and membership", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "phase5-handoff-"));
  const file = path.join(directory, "handoff.csv");
  const header = "product_code,video_id,external_product_id,frontier_membership_hash\n";
  try {
    await fs.writeFile(file, `${header}PHASE500001,video-1,phase500001,${membership}\nPHASE500002,video-2,phase500002,${membership}\n`);
    const rows = await loadExactHandoff(file, 2);
    assert.deepEqual(rows.map((item) => item.product_code), ["PHASE500001", "PHASE500002"]);
    await assert.rejects(() => loadExactHandoff(file, 3), /HANDOFF_COUNT_MISMATCH/);

    await fs.writeFile(file, `${header}PHASE500001,video-1,phase500001,${membership}\nPHASE500001,video-2,phase500002,${membership}\n`);
    await assert.rejects(() => loadExactHandoff(file, 2), /HANDOFF_DUPLICATE_CODE/);

    await fs.writeFile(file, `${header}PHASE500001,,phase500001,${membership}\n`);
    await assert.rejects(() => loadExactHandoff(file, 1), /HANDOFF_MISSING_VIDEO_ID/);

    await fs.writeFile(file, `${header}PHASE500001,video-1,phase500001,${membership}\nPHASE500002,video-2,phase500002,${"7".repeat(64)}\n`);
    await assert.rejects(() => loadExactHandoff(file, 2), /HANDOFF_MEMBERSHIP_MISMATCH/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("exact handoff accepts the durable frontier membership_sha field", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "phase5-handoff-membership-sha-"));
  const file = path.join(directory, "handoff.csv");
  try {
    await fs.writeFile(
      file,
      `product_code,video_id,external_product_id,membership_sha\nPHASE500001,video-1,phase500001,${membership}\n`,
    );
    const rows = await loadExactHandoff(file, 1);
    assert.equal(rows[0].membership_sha, membership);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("adaptive sample indices are deterministic, distributed, and interleaved", () => {
  const stage1 = selectEvenlyDistributedIndices(40, 8);
  const stage2 = selectInterleavedIndices(40, stage1, 8);
  assert.equal(stage1.length, 8);
  assert.equal(stage1[0], 1);
  assert.equal(stage1.at(-1), 40);
  assert.equal(stage2.length, 8);
  assert.equal(new Set([...stage1, ...stage2]).size, 16);
  assert.deepEqual(selectEvenlyDistributedIndices(3, 8), [1, 2, 3]);
  assert.deepEqual(selectEvenlyDistributedIndices(0, 8), []);
  assert.deepEqual(deduplicatedSampleSourceIndices([
    "https://pics.dmm.co.jp/digital/video/phase500001/phase500001-1.jpg",
    "https://pics.dmm.co.jp/digital/video/phase500001/phase500001jp-1.jpg",
    "https://pics.dmm.co.jp/digital/video/phase500001/phase500001-2.jpg",
    "https://pics.dmm.co.jp/digital/video/phase500001/phase500001jp-2.jpg",
  ]), [2, 4]);
});

test("adaptive review defaults remain 8 while this cohort can cap both stages at 6", () => {
  const defaults = parseAdaptiveReviewArgs(["--handoff-file", "/tmp/handoff.csv"]);
  assert.equal(defaults.stage1Max, 8);
  assert.equal(defaults.stage2Max, 8);
  const capped = parseAdaptiveReviewArgs([
    "--handoff-file", "/tmp/handoff.csv",
    "--stage1-max", "6",
    "--stage2-max", "6",
  ]);
  assert.equal(capped.stage1Max, 6);
  assert.equal(capped.stage2Max, 6);
  assert.deepEqual(selectEvenlyDistributedIndices(40, 6), [1, 9, 17, 24, 32, 40]);
  assert.equal(selectInterleavedIndices(40, selectEvenlyDistributedIndices(40, 6), 6).length, 6);
  assert.throws(
    () => parseAdaptiveReviewArgs(["--handoff-file", "/tmp/handoff.csv", "--stage1-max", "9"]),
    /INVALID_STAGE_MAX/,
  );
  const concurrent = parseAdaptiveReviewArgs([
    "--handoff-file", "/tmp/handoff.csv",
    "--image-concurrency", "6",
  ]);
  assert.equal(concurrent.imageConcurrency, 6);
  assert.throws(
    () => parseAdaptiveReviewArgs(["--handoff-file", "/tmp/handoff.csv", "--image-concurrency", "9"]),
    /INVALID_IMAGE_CONCURRENCY/,
  );
});

test("adaptive Stage 2 and Stage 3 select only explicitly escalated works", () => {
  const allCodes = ["CLEAR", "PACKAGE_WINS", "COMPETITIVE"];
  const stage2Classifications = {
    CLEAR: "FINAL_KEEP",
    PACKAGE_WINS: "SAMPLE_POTENTIALLY_COMPETITIVE",
    COMPETITIVE: "SAMPLE_POTENTIALLY_COMPETITIVE",
  };
  assert.deepEqual(selectAdaptiveStageCodes({
    stage: 2,
    allCodes,
    classifications: stage2Classifications,
  }), ["PACKAGE_WINS", "COMPETITIVE"]);
  const works = {
    CLEAR: { stage1_classification: "FINAL_KEEP", stage2_classification: "FINAL_KEEP" },
    PACKAGE_WINS: { stage1_classification: "SAMPLE_POTENTIALLY_COMPETITIVE", stage2_classification: "FINAL_RIGHT" },
    COMPETITIVE: { stage1_classification: "SAMPLE_POTENTIALLY_COMPETITIVE", stage2_classification: "SAMPLE_STILL_COMPETITIVE" },
  };
  assert.deepEqual(selectAdaptiveStageCodes({
    stage: 3,
    allCodes,
    works,
    classifications: {
      PACKAGE_WINS: "PACKAGE_CLEAR_WIN",
      COMPETITIVE: "SAMPLE_STILL_COMPETITIVE",
    },
  }), ["COMPETITIVE"]);
});

test("durable package decisions preserve exact mode, hashes, reason, and stage", () => {
  const packageFull = v3Candidate({
    type: "dvd_full",
    sampleIndex: null,
    sourceUrl: "https://pics.dmm.co.jp/digital/video/phase500001/phase500001pl.jpg",
    url: "https://pics.dmm.co.jp/digital/video/phase500001/phase500001pl.jpg",
    sourceHash: HASH_A,
    outputHash: HASH_A,
  });
  const packageRight = v3Candidate({
    type: "dvd_right",
    sampleIndex: null,
    sourceUrl: packageFull.sourceUrl,
    url: "generated:PHASE500001-auto-right.jpg",
    sourceHash: HASH_A,
    outputHash: HASH_B,
  });
  const record = {
    code: "PHASE500001",
    fetched_sample_indices: [1, 9, 17, 24, 32, 40],
    v3Row: row([packageRight, packageFull], {
      current_url: packageFull.url,
      current_type: "dvd_full",
    }),
  };
  const decision = {
    classification: "FINAL_RIGHT",
    visual_reason: "right panel preserves the main subject and title while full is too small in the card frame",
    reviewed_at: "2026-08-26T10:00:00.000Z",
  };
  applyStageDecision(record, decision, 1);
  assert.equal(record.final_decision, "APPROVE_RIGHT");
  assert.equal(record.final_mode, "PACKAGE_RIGHT");
  assert.equal(record.final_source_id, "dvd:right");
  assert.equal(record.final_source_hash, HASH_A);
  assert.equal(record.final_output_hash, HASH_B);
  assert.equal(record.package_source_hash, HASH_A);
  assert.equal(record.decision_stage, 1);
  assert.equal(record.reviewed, true);
  assert.match(record.visual_reason, /right panel preserves/);
  const recordedReason = record.visual_reason;
  applyStageDecision(record, decision, 1);
  applyStageDecision(record, {
    ...decision,
    visual_reason: "a later resume must not rewrite durable visual evidence",
  }, 1);
  assert.equal(record.visual_reason, recordedReason);
  assert.throws(() => applyStageDecision(record, {
    ...decision,
    classification: "FINAL_FULL",
  }, 2), /FINAL_DECISION_ALREADY_RECORDED/);
});

test("Stage 3 SAMPLE finalization requires and preserves the original sample:N", () => {
  const sample = v3Candidate({ sampleIndex: 17 });
  const packageFull = v3Candidate({
    type: "dvd_full",
    sampleIndex: null,
    sourceUrl: "https://pics.dmm.co.jp/digital/video/phase500001/phase500001pl.jpg",
    url: "https://pics.dmm.co.jp/digital/video/phase500001/phase500001pl.jpg",
  });
  const record = {
    code: "PHASE500001",
    fetched_sample_indices: [17],
    v3Row: row([sample, packageFull], { current_url: packageFull.url, current_type: "dvd_full" }),
  };
  assert.throws(() => applyStageDecision(record, {
    classification: "FINAL_SAMPLE",
    source_id: "sample:16",
    visual_reason: "sample 16",
    reviewed_at: "2026-08-26T10:00:00.000Z",
  }, 3), /SAMPLE_CANDIDATE_NOT_FETCHED/);
  applyStageDecision(record, {
    classification: "FINAL_SAMPLE",
    source_id: "sample:17",
    visual_reason: "sample 17 shows the complete representative scene without package context loss",
    reviewed_at: "2026-08-26T10:00:00.000Z",
  }, 3);
  assert.equal(record.final_decision, "APPROVE_SAMPLE");
  assert.equal(record.final_mode, "SAMPLE");
  assert.equal(record.final_source_id, "sample:17");
  assert.equal(record.decision_stage, 3);
  record.v3Row.candidates.push(v3Candidate({
    sampleIndex: 18,
    sourceUrl: "https://pics.dmm.co.jp/digital/video/phase500001/phase500001jp-18.jpg",
  }));
  assert.throws(() => applyStageDecision(record, {
    classification: "FINAL_SAMPLE",
    source_id: "sample:18",
    visual_reason: "resume cannot replace the selected original sample index",
    reviewed_at: "2026-08-26T10:01:00.000Z",
  }, 3), /FINAL_DECISION_ALREADY_RECORDED/);
});

test("V3 scoped samples retain original sample:N and one network GET per URL", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "phase5-adaptive-v3-"));
  const originalFetch = globalThis.fetch;
  const image = await sharp({
    create: { width: 800, height: 600, channels: 3, background: { r: 120, g: 80, b: 160 } },
  }).jpeg().toBuffer();
  globalThis.fetch = async () => new Response(image, { status: 200, headers: { "content-type": "image/jpeg" } });
  try {
    configureThumbnailCandidateV3({ repositoryRoot: directory, outputDirectory: directory, cacheDirectory: path.join(directory, "cache") });
    const scopedVideo = video({
      thumbnail_url: "https://pics.dmm.co.jp/digital/video/phase500001/phase500001pl.jpg",
      sample_images: [1, 2, 3, 4].map((index) => `https://pics.dmm.co.jp/digital/video/phase500001/phase500001jp-${index}.jpg`),
    });
    const first = await decideThumbnailCandidateV3(scopedVideo, {
      deduplicateSamplePairs: true,
      candidateLimit: null,
      sampleIndices: [2, 4],
    });
    assert.deepEqual(
      first.candidates.filter((candidate) => candidate.type === "sample").map((candidate) => candidate.sampleIndex).sort(),
      [2, 4],
    );
    assert.equal(getThumbnailCandidateV3FetchStats().totalNetworkGets, 3);
    await decideThumbnailCandidateV3(scopedVideo, {
      deduplicateSamplePairs: true,
      candidateLimit: null,
      sampleIndices: [2, 4],
    });
    assert.equal(getThumbnailCandidateV3FetchStats().totalNetworkGets, 3);
    assert.equal(getThumbnailCandidateV3FetchStats().duplicateNetworkGets, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("scoped DB retrieval chunks only exact IDs and never performs a global range", async () => {
  const calls = [];
  const db = {
    from(table) {
      return {
        select(select) {
          return {
            async in(column, values) {
              calls.push({ table, select, column, values: [...values] });
              return { data: values.map((id) => ({ id })), error: null };
            },
          };
        },
      };
    },
  };
  const rows = await fetchRowsByExactValues(db, {
    table: "videos",
    select: "id,product_code",
    column: "id",
    values: ["a", "b", "c", "d", "e"],
    chunkSize: 2,
  });
  assert.deepEqual(rows.map((item) => item.id), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(calls.map((call) => call.values), [["a", "b"], ["c", "d"], ["e"]]);
  assert.equal(calls.every((call) => call.table === "videos" && call.column === "id"), true);
});

test("exact scope rejects missing/foreign rows and preserves handoff order", () => {
  const handoff = [
    { product_code: "PHASE500002", video_id: "video-2", external_product_id: "phase500002" },
    { product_code: "PHASE500001", video_id: "video-1", external_product_id: "phase500001" },
  ];
  const videos = [
    video({ id: "video-1", product_code: "PHASE500001", external_product_id: "phase500001" }),
    video({ id: "video-2", product_code: "PHASE500002", external_product_id: "phase500002" }),
  ];
  const sources = [
    { promoted_video_id: "video-1", normalized_product_code: "PHASE500001", external_product_id: "phase500001" },
    { promoted_video_id: "video-2", normalized_product_code: "LEGACY_PHASE500002", external_product_id: "phase500002" },
  ];
  assert.deepEqual(validateExactScopeRows(handoff, videos, sources).map((item) => item.id), ["video-2", "video-1"]);
  assert.throws(() => validateExactScopeRows(handoff, videos.slice(0, 1), sources), /SCOPED_VIDEO_COUNT_MISMATCH/);
  assert.throws(
    () => validateExactScopeRows(handoff, videos.map((item) => ({ ...item, source_name: "manual" })), sources),
    /SCOPED_VIDEO_NOT_PUBLISHED_FANZA/,
  );
});

test("future FANZA discovery is provenance-based and existing decisions/protections always win", () => {
  const base = video();
  assert.equal(isPhase5ThumbnailCandidatePending({ video: base }), true);
  for (const protection of [
    { hasProductionDecision: true },
    { hasPhase4BDecision: true },
    { hasLegacyOverride: true },
    { isProtectedExclusion: true },
  ]) {
    assert.equal(isPhase5ThumbnailCandidatePending({ video: base, ...protection }), false);
  }
  assert.equal(isPhase5ThumbnailCandidatePending({ video: { ...base, is_published: false } }), false);
  assert.equal(isPhase5ThumbnailCandidatePending({ video: { ...base, source_name: "manual" } }), false);
});

test("sample source ID preserves the actual array index and apply remains false", () => {
  const candidate = v3Candidate({
    sampleIndex: 7,
    url: "https://pics.dmm.co.jp/digital/video/phase500001/phase500001jp-7.jpg",
    sourceUrl: "https://pics.dmm.co.jp/digital/video/phase500001/phase500001jp-7.jpg",
  });
  const record = buildPhase5CandidateRecord({ video: video(), v3Row: row([candidate]) });
  assert.equal(record.candidate_mode, "SAMPLE");
  assert.equal(record.candidate_source_id, "sample:7");
  assert.equal(record.sample_index, 7);
  assert.equal(record.apply, false);
  assert.equal(record.review_status, "PENDING_REVIEW");
});

test("RIGHT and CENTER retain package source hash and exact crop provenance", () => {
  for (const [type, mode, sourceId, left] of [
    ["dvd_right", "PACKAGE_RIGHT", "dvd:right", 520],
    ["dvd_center", "PACKAGE_CENTER", "dvd:center", 260],
  ]) {
    const candidate = v3Candidate({
      type,
      url: `generated:PHASE500001-auto-${type === "dvd_right" ? "right" : "center"}.jpg`,
      sourceUrl: "https://pics.dmm.co.jp/digital/video/phase500001/phase500001pl.jpg",
      sourceHash: HASH_A,
      outputHash: HASH_B,
      sampleIndex: null,
      cropLeft: left,
      cropWidth: 735,
      sourceWidth: 1200,
      sourceHeight: 1000,
    });
    const record = buildPhase5CandidateRecord({ video: video(), v3Row: row([candidate]) });
    assert.equal(record.candidate_mode, mode);
    assert.equal(record.candidate_source_id, sourceId);
    assert.equal(record.candidate_url.endsWith("phase500001pl.jpg"), true);
    assert.equal(record.candidate_source_hash, HASH_A);
    assert.equal(record.candidate_output_hash, HASH_B);
    assert.equal(record.crop_left, left);
    assert.equal(record.crop_width, 735);
  }
});

test("candidate generation is deterministic and classifications never imply apply", () => {
  const records = [buildPhase5CandidateRecord({ video: video(), v3Row: row([v3Candidate()]) })];
  assert.equal(phase5CandidateDigest(records), phase5CandidateDigest(structuredClone(records)));
  assert.deepEqual(candidateSummary(records), {
    total: 1,
    candidate_generated: 1,
    no_candidate: 0,
    recommended_modes: { SAMPLE: 1 },
    confidence: { medium: 1 },
    risk: { review: 1 },
    classification: { B: 1 },
    apply_true: 0,
  });
  assert.deepEqual(selectProductionEligiblePhase5Records(records), []);
});

test("SAMPLE candidates are review-only even with a high score and no visual risk", () => {
  const sample = v3Candidate({ score: 180, review: false });
  const gate = classifyThumbnailCandidate({ best: sample });
  assert.deepEqual(
    { classification: gate.classification, risk: gate.risk, confidence: gate.confidence },
    { classification: "B", risk: "review", confidence: "medium" },
  );
  assert.equal(gate.reason_codes.includes("SAMPLE_REQUIRES_REVIEW"), true);
});

test("FULL requires a calibrated lead over RIGHT before it can be Class A", () => {
  const full = v3Candidate({ type: "dvd_full", score: 140 });
  const closeRight = v3Candidate({ type: "dvd_right", score: 140 - FULL_RIGHT_REVIEW_GAP + 1 });
  const clearRight = v3Candidate({ type: "dvd_right", score: 140 - FULL_RIGHT_REVIEW_GAP });
  const close = classifyThumbnailCandidate({ best: full, runnerUp: closeRight, rightCandidate: closeRight });
  const clear = classifyThumbnailCandidate({ best: full, runnerUp: clearRight, rightCandidate: clearRight });
  assert.equal(close.classification, "B");
  assert.equal(close.reason_codes.includes("FULL_RIGHT_MARGIN_TOO_SMALL"), true);
  assert.equal(clear.classification, "A");
});

test("RIGHT and CENTER ranking remains intact while ambiguous cases are review-only", () => {
  const right = v3Candidate({ type: "dvd_right", score: 140 });
  const center = v3Candidate({ type: "dvd_center", score: 140 });
  assert.equal(classifyThumbnailCandidate({ best: right }).classification, "A");
  assert.equal(classifyThumbnailCandidate({ best: right, sampleCandidateAvailable: true }).classification, "B");
  assert.equal(classifyThumbnailCandidate({ best: center }).classification, "B");
});

test("Phase 5 consumes the V3 decision gate as its single classification truth", () => {
  const candidate = v3Candidate({
    type: "dvd_right",
    sampleIndex: null,
    cropLeft: 520,
    cropWidth: 735,
    sourceWidth: 1200,
    sourceHeight: 1000,
  });
  const decisionGate = Object.freeze({
    classification: "B",
    confidence: "medium",
    risk: "review",
    needs_review: true,
    reason_codes: ["RIGHT_WITH_SAMPLE_CANDIDATES_REQUIRES_REVIEW"],
  });
  const record = buildPhase5CandidateRecord({
    video: video(),
    v3Row: row([candidate], { decision_gate: decisionGate }),
  });
  assert.equal(record.classification, "B");
  assert.equal(record.confidence, "medium");
  assert.equal(record.risk, "review");
});

test("apply=false reviewed rows cannot enter the generated Phase 5 registry", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "phase5-reviewed-"));
  const file = path.join(directory, "reviewed.csv");
  const header = "code,mode,source_id,source_path_or_url,source_hash,output_path_or_url,output_hash,approved_by,approved_at,approval_batch,reason,apply,review_status\n";
  const pending = `PHASE500001,SAMPLE,sample:1,https://pics.dmm.co.jp/digital/video/phase500001/phase500001jp-1.jpg,${HASH_A},https://pics.dmm.co.jp/digital/video/phase500001/phase500001jp-1.jpg,${HASH_A},,,,,false,PENDING_REVIEW\n`;
  try {
    await fs.writeFile(file, header + pending);
    const result = await generatePhase5ReviewedSource({ decisionFilePath: file });
    assert.equal(result.records.length, 0);
    assert.deepEqual(result.stats, {
      input_total: 1,
      eligible_total: 0,
      ignored_apply_false: 1,
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("stratified canary is fixed at 10 SAMPLE 10 RIGHT 5 CENTER 5 FULL", () => {
  const modes = [
    ["SAMPLE", "sample:1", 10],
    ["PACKAGE_RIGHT", "dvd:right", 10],
    ["PACKAGE_CENTER", "dvd:center", 5],
    ["PACKAGE_FULL", "dvd:full", 5],
  ];
  const records = modes.flatMap(([mode, sourceId, count], modeIndex) =>
    Array.from({ length: count }, (_, index) => ({
      product_code: `CANARY${modeIndex}${String(index).padStart(3, "0")}`,
      candidate_mode: mode,
      candidate_source_id: sourceId,
      confidence: "high",
      score: 100 - index,
      created_at: `2026-08-${String(11 + (index % 4)).padStart(2, "0")}T00:00:00Z`,
      maker_name: `maker-${index}`,
      series_name: `series-${index}`,
    })));
  const canary = selectStratifiedCanary(records);
  assert.equal(canary.length, 30);
  assert.deepEqual(
    Object.fromEntries(modes.map(([mode]) => [mode, canary.filter((row) => row.candidate_mode === mode).length])),
    { SAMPLE: 10, PACKAGE_RIGHT: 10, PACKAGE_CENTER: 5, PACKAGE_FULL: 5 },
  );
});

test("production registry grows only by reviewed records and ten no-change controls remain unchanged", () => {
  assert.equal(PRODUCTION_THUMBNAIL_DECISIONS.size, 2799);
  const canonical = [
    ["1START00590", "SAMPLE", "sample:1"],
    ["1SBP00423", "SCENE_FULL", "scene:pl"],
    ["H_1784FT000062", "PACKAGE_FULL", "dvd:full"],
    ["H_1784FT000064", "PACKAGE_FULL", "dvd:full"],
    ["1NAMHS00006", "PACKAGE_RIGHT", "dvd:right"],
    ["AQUGL00004", "SAMPLE", "sample:12"],
    ["5561SGKT00002", "PACKAGE_RIGHT", "dvd:right"],
    ["H_068MXDLP00335", "PACKAGE_FULL", "dvd:full"],
    ["1SBP00416", "SCENE_CROP", "scene:pl"],
  ];
  for (const [code, mode, sourceId] of canonical) {
    const decision = getProductionThumbnailDecision(code);
    assert.equal(decision?.mode, mode, code);
    assert.equal(decision?.source_id, sourceId, code);
  }
  const center = PHASE4B_LEGACY_THUMBNAIL_DECISIONS.get("EBWH00344");
  assert.equal(center?.mode, "PACKAGE_CENTER");
  assert.equal(center?.source_id, "dvd:center");
});
