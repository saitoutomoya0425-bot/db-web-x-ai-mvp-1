import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseCsv } from "../scripts/generate-thumbnail-production-registry.mjs";
import {
  PHASE4E_SAMPLE_RANKING_POLICY,
  rankPhase4ECandidates,
  scorePhase4ECandidate,
} from "../scripts/lib/thumbnail-sample-ranking-phase4e.mjs";

const labels = parseCsv(await readFile("data/thumbnail-phase4e-ranking-labels.csv", "utf8"));
const candidate = (overrides = {}) => ({
  code: "RANK0001",
  mode: "SAMPLE",
  source_id: "sample:1",
  source_path_or_url: "https://pics.dmm.co.jp/digital/video/rank0001/rank0001jp-1.jpg",
  source_hash: "a".repeat(64),
  visual_quality_score: 15,
  work_information_score: 15,
  identity_and_context_score: 15,
  representativeness_score: 15,
  card_subject_retention_score: 15,
  subject_scale_score: 15,
  orientation_score: 15,
  card_composition_score: 15,
  ...overrides,
});

test("Phase 4E teacher data has four positives eight negatives and zero apply rows", () => {
  assert.equal(labels.length, 12);
  assert.equal(labels.filter((row) => row.label === "POSITIVE").length, 4);
  assert.equal(labels.filter((row) => row.label === "NEGATIVE").length, 8);
  assert.equal(labels.filter((row) => row.apply === "true").length, 0);
  assert.deepEqual(PHASE4E_SAMPLE_RANKING_POLICY, {
    sample_vs_package_margin: 12,
    candidate_margin: 8,
    auto_apply: false,
    center_requires_invalid_sides: true,
    scene_crop_allowed: false,
  });
});

test("human positive identity wins while all eight exact negatives remain rejected", () => {
  for (const positive of labels.filter((row) => row.label === "POSITIVE")) {
    const negatives = labels.filter(
      (row) => row.code === positive.code && row.label === "NEGATIVE",
    );
    const candidates = [
      candidate({ ...positive, visual_quality_score: 1 }),
      ...negatives.map((row, index) => candidate({
        ...row,
        visual_quality_score: 20,
        work_information_score: 20,
        identity_and_context_score: 20,
        representativeness_score: 20,
        card_subject_retention_score: 20,
        subject_scale_score: 20,
        orientation_score: 20,
        card_composition_score: 20,
        source_id: row.source_id,
        source_path_or_url: row.source_path_or_url,
        source_hash: row.source_hash,
        ranking_index: index,
      })),
    ];
    const result = rankPhase4ECandidates({ candidates, labels });
    assert.equal(result.selected.source_id, "sample:1", positive.code);
    assert.equal(result.confidence, "human", positive.code);
    assert.equal(result.auto_apply, false, positive.code);
    for (const sourceId of negatives.map((row) => row.source_id)) {
      assert.equal(result.selected.source_id === sourceId, false, `${positive.code}:${sourceId}`);
    }
  }
});

test("7:10 subject loss partial composition orientation whitespace and duplicates are penalized", () => {
  const baseline = scorePhase4ECandidate(candidate());
  const degraded = scorePhase4ECandidate(candidate({
    source_id: "sample:2",
    source_path_or_url: "https://pics.dmm.co.jp/digital/video/rank0001/rank0001jp-2.jpg",
    source_hash: "b".repeat(64),
    face_or_primary_subject_lost: true,
    subject_too_small: true,
    local_or_partial_composition: true,
    orientation_invalid: true,
    duplicate_or_near_duplicate: true,
    whitespace_penalty: 20,
    card_context_loss_penalty: 30,
  }));
  assert.ok(degraded.score < baseline.score - 150);
  assert.ok(degraded.reason_codes.includes("CARD_PRIMARY_SUBJECT_LOST"));
  assert.ok(degraded.reason_codes.includes("CARD_SUBJECT_TOO_SMALL"));
  assert.ok(degraded.reason_codes.includes("LOCAL_OR_PARTIAL_COMPOSITION"));
  assert.ok(degraded.reason_codes.includes("INVALID_ORIENTATION"));
  assert.ok(degraded.reason_codes.includes("DUPLICATE_OR_NEAR_DUPLICATE"));
});

test("sample must clearly beat package and a close race requires user review", () => {
  const right = candidate({
    mode: "PACKAGE_RIGHT",
    source_id: "dvd:right",
    source_path_or_url: "public/card-thumbnails/RANK0001-auto-right.jpg",
    source_hash: "c".repeat(64),
  });
  const closeSample = candidate({ source_id: "sample:2", source_hash: "b".repeat(64) });
  const close = rankPhase4ECandidates({ candidates: [closeSample, right] });
  assert.equal(close.classification, "NEEDS_USER_REVIEW");
  assert.equal(close.auto_apply, false);

  const strongSample = candidate({
    source_id: "sample:3",
    source_path_or_url: "https://pics.dmm.co.jp/digital/video/rank0001/rank0001jp-3.jpg",
    source_hash: "d".repeat(64),
    visual_quality_score: 20,
    work_information_score: 20,
    identity_and_context_score: 20,
    representativeness_score: 20,
    card_subject_retention_score: 20,
    subject_scale_score: 20,
    orientation_score: 20,
    card_composition_score: 20,
  });
  const clear = rankPhase4ECandidates({ candidates: [strongSample, right] });
  assert.equal(clear.classification, "HIGH_CONFIDENCE_SAMPLE");
  assert.equal(clear.selected.source_id, "sample:3");
  assert.equal(clear.auto_apply, false);
});

test("package fallback prefers RIGHT then FULL and permits CENTER only for invalid sides", () => {
  const rightWithLoss = candidate({
    mode: "PACKAGE_RIGHT",
    source_id: "dvd:right",
    source_path_or_url: "public/card-thumbnails/RANK0001-auto-right.jpg",
    source_hash: "b".repeat(64),
    right_important_information_loss: true,
  });
  const full = candidate({
    mode: "PACKAGE_FULL",
    source_id: "dvd:full",
    source_path_or_url: "https://pics.dmm.co.jp/digital/video/rank0001/rank0001pl.jpg",
    source_hash: "c".repeat(64),
  });
  const invalidCenter = candidate({
    mode: "PACKAGE_CENTER",
    source_id: "dvd:center",
    source_path_or_url: "https://pics.dmm.co.jp/digital/video/rank0001/rank0001pl.jpg",
    source_hash: "c".repeat(64),
    sides_invalid: false,
  });
  const result = rankPhase4ECandidates({ candidates: [rightWithLoss, full, invalidCenter] });
  assert.equal(result.selected.mode, "PACKAGE_FULL");
  assert.equal(result.auto_apply, false);

  const centerOnly = rankPhase4ECandidates({ candidates: [{ ...invalidCenter, sides_invalid: true }] });
  assert.equal(centerOnly.selected.mode, "PACKAGE_CENTER");
  assert.equal(centerOnly.classification, "NEEDS_USER_REVIEW");
  assert.equal(centerOnly.auto_apply, false);
});
