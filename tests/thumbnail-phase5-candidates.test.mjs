import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  const header = "code,video_id,external_product_id,mode,source_id,source_path_or_url,source_hash,output_path_or_url,output_hash,crop_left,crop_width,source_width,source_height,approved_by,approved_at,approval_batch,reason,apply,review_status\n";
  const pending = `PHASE500001,video-phase5-1,phase500001,SAMPLE,sample:1,https://pics.dmm.co.jp/digital/video/phase500001/phase500001jp-1.jpg,${HASH_A},https://pics.dmm.co.jp/digital/video/phase500001/phase500001jp-1.jpg,${HASH_A},,,800,450,,,,false,PENDING_REVIEW\n`;
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

test("production registry and ten no-change controls remain unchanged", () => {
  assert.equal(PRODUCTION_THUMBNAIL_DECISIONS.size, 134);
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
