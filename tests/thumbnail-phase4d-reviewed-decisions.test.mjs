import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  GENERATED_PHASE4C_REVIEWED_DECISION_RECORDS,
} from "../src/lib/thumbnail/generated-phase4c-reviewed-decisions.ts";
import {
  GENERATED_PHASE4D_REVIEWED_DECISION_RECORDS,
  GENERATED_PHASE4D_REVIEWED_INPUT_SHA256,
  GENERATED_PHASE4D_REVIEWED_STATS,
} from "../src/lib/thumbnail/generated-phase4d-reviewed-decisions.ts";
import {
  GENERATED_PHASE4E_REVIEWED_DECISION_RECORDS,
} from "../src/lib/thumbnail/generated-phase4e-reviewed-decisions.ts";
import {
  getProductionThumbnailDecision,
  PRODUCTION_BASELINE_THUMBNAIL_DECISIONS,
  PRODUCTION_THUMBNAIL_DECISIONS,
  PRODUCTION_THUMBNAIL_REGISTRY_CONFLICTS,
} from "../src/lib/thumbnail/production-registry.ts";
import {
  getPhase4BLegacyThumbnailDecision,
  PHASE4B_LEGACY_THUMBNAIL_DECISIONS,
} from "../src/lib/thumbnail/phase4b-legacy-registry.ts";
import {
  buildThumbnailRenderContract,
  resolveThumbnailPresentation,
} from "../src/lib/thumbnail/presentation.ts";
import { thumbnailStructuredDataImage } from "../src/lib/thumbnail/structured-data.ts";
import { parseCsv } from "../scripts/generate-thumbnail-production-registry.mjs";

const DATA_PATH = "data/thumbnail-phase4d-reviewed-decisions.csv";
const FIXTURE_PATH = "data/thumbnail-phase4d-user-review-fixtures.csv";
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const dataBytes = await readFile(DATA_PATH);
const decisionRows = parseCsv(dataBytes.toString("utf8"));
const fixtures = parseCsv(await readFile(FIXTURE_PATH, "utf8"));
const recordsByCode = new Map(
  GENERATED_PHASE4D_REVIEWED_DECISION_RECORDS.map((record) => [record.code, record]),
);
const phase4EByCode = new Map(
  GENERATED_PHASE4E_REVIEWED_DECISION_RECORDS.map((record) => [record.code, record]),
);
const OVERRIDES = Object.freeze({
  KIWVR00907: "sample:2",
  KSBJ00438: "sample:5",
  LUCY00029: "sample:3",
  UMSO00650: "sample:9",
});

test("Phase 4D records only 14 image-changing user decisions and zero automatic decisions", () => {
  assert.equal(decisionRows.length, 14);
  assert.equal(recordsByCode.size, 14);
  assert.deepEqual(GENERATED_PHASE4D_REVIEWED_STATS, {
    total: 14,
    SAMPLE: 4,
    PACKAGE_RIGHT: 8,
    PACKAGE_FULL: 2,
    auto_applied: 0,
  });
  assert.equal(GENERATED_PHASE4D_REVIEWED_INPUT_SHA256, sha256(dataBytes));
  for (const row of decisionRows) {
    assert.equal(row.apply, "true", row.code);
    assert.equal(row.approved_by, "USER_HANDOFF", row.code);
    assert.equal(row.approved_at, "2026-08-02", row.code);
    assert.equal(row.approval_batch, "PHASE_4D_USER_REVIEW", row.code);
    assert.equal(row.source_hash, row.output_hash, row.code);
    assert.ok(recordsByCode.has(row.code), row.code);
  }
});

test("the formal fixture contains R2 final decisions and R1 teacher decisions without production inflation", () => {
  assert.equal(fixtures.length, 39);
  assert.equal(new Set(fixtures.map((row) => row.code)).size, 39);
  assert.equal(fixtures.filter((row) => row.review_set === "PHASE_4D_R2").length, 24);
  assert.equal(fixtures.filter((row) => row.review_set === "PHASE_4D_R1").length, 15);
  assert.equal(fixtures.filter((row) => row.selection === "CURRENT").length, 10);
  assert.equal(fixtures.filter((row) => row.production_effect === "PRODUCTION_DECISION").length, 14);
  assert.equal(fixtures.filter((row) => row.production_effect === "REGRESSION_ONLY").length, 25);

  for (const row of fixtures) {
    assert.equal(row.approved_by, "USER_HANDOFF", row.code);
    assert.equal(row.approved_at, "2026-08-02", row.code);
    assert.equal(row.approval_batch, "PHASE_4D_USER_REVIEW", row.code);
    if (row.production_effect === "PRODUCTION_DECISION") {
      const decision = getProductionThumbnailDecision(row.code);
      assert.ok(decision, row.code);
      const latest = phase4EByCode.get(row.code);
      assert.equal(decision.mode, latest?.mode ?? row.expected_mode, row.code);
      assert.equal(decision.source_id, latest?.source_id ?? row.expected_source_id, row.code);
    } else {
      assert.equal(recordsByCode.has(row.code), false, row.code);
      const presentation = resolveThumbnailPresentation({ code: row.code });
      assert.equal(presentation.mode, row.expected_mode, row.code);
      assert.equal(presentation.source_id, row.expected_source_id, row.code);
    }
  }
});

test("the four Phase 4D Preview corrections remain as history under the Phase 4E supersession", () => {
  const oldPhase4C = new Map(
    GENERATED_PHASE4C_REVIEWED_DECISION_RECORDS.map((record) => [record.code, record]),
  );
  for (const [code, sourceId] of Object.entries(OVERRIDES)) {
    const previous = oldPhase4C.get(code);
    const phase4D = recordsByCode.get(code);
    const phase4E = phase4EByCode.get(code);
    assert.ok(previous, code);
    assert.ok(phase4D, code);
    assert.ok(phase4E, code);
    assert.equal(previous.mode, "SAMPLE", code);
    assert.equal(previous.source_id, sourceId, code);
    assert.equal(phase4D.source_id, sourceId, code);
    assert.equal(phase4E.source_id, "sample:1", code);

    const decision = getProductionThumbnailDecision(code);
    assert.ok(decision, code);
    assert.equal(decision.mode, "SAMPLE", code);
    assert.equal(decision.source_id, "sample:1", code);
    assert.equal(decision.approval_status, "HUMAN_APPROVED", code);
    assert.equal(decision.render_status, "READY", code);
    assert.equal(decision.approved_by, "USER_HANDOFF", code);
    assert.equal(decision.approved_at, "2026-08-03", code);
    assert.equal(decision.approval_batch, "PHASE_4E_USER_REVIEW", code);
    assert.equal(decision.source_path_or_url, phase4E.source_path_or_url, code);
    assert.equal(decision.source_hash, phase4E.source_hash, code);
    assert.equal(decision.output_path_or_url, phase4E.output_path_or_url, code);
    assert.equal(decision.output_hash, phase4E.output_hash, code);
    assert.match(decision.reason, /Phase 4C\/4Dの旧decisionを置換/, code);

    const input = {
      code,
      legacy_runtime_override: {
        path: `/card-thumbnails/${code}-auto-right.jpg`,
        mode: "right",
        source_id: "dvd:right",
        output_hash: null,
      },
      legacy_card_url: `/card-thumbnails/${code}-auto-right.jpg`,
      legacy_thumbnail_url: `https://db.invalid/${code}.jpg`,
    };
    const surfaces = ["list", "detail", "related", "recently-viewed"].map(() =>
      resolveThumbnailPresentation(input)
    );
    assert.equal(new Set(surfaces.map((value) => JSON.stringify(value))).size, 1, code);
    for (const resolution of surfaces) {
      assert.equal(resolution.resolution_kind, "CANONICAL", code);
      assert.equal(resolution.mode, "SAMPLE", code);
      assert.equal(resolution.source_id, "sample:1", code);
      assert.equal(resolution.resolved_url, decision.output_path_or_url, code);
      assert.equal(resolution.object_fit, "scale-down", code);
    }
    const contract = buildThumbnailRenderContract(surfaces[0]);
    assert.equal(contract.src, decision.output_path_or_url, code);
    assert.equal(contract.object_position, "center", code);
    const structured = thumbnailStructuredDataImage(surfaces[0], "https://preview.example.test");
    assert.equal(structured.image, decision.output_path_or_url, code);
  }
});

test("all 14 changed decisions resolve identically on list detail related recent and JSON-LD", () => {
  for (const record of GENERATED_PHASE4D_REVIEWED_DECISION_RECORDS) {
    const latest = phase4EByCode.get(record.code) ?? record;
    const decision = getProductionThumbnailDecision(record.code);
    assert.ok(decision, record.code);
    assert.equal(decision.mode, latest.mode, record.code);
    assert.equal(decision.source_id, latest.source_id, record.code);
    assert.equal(decision.source_path_or_url, latest.source_path_or_url, record.code);
    assert.equal(decision.source_hash, latest.source_hash, record.code);
    assert.equal(decision.output_path_or_url, latest.output_path_or_url, record.code);
    assert.equal(decision.output_hash, latest.output_hash, record.code);
    assert.equal(decision.crop_spec, null, record.code);
    const expectedFit = latest.mode === "PACKAGE_FULL"
      ? "contain"
      : latest.mode === "SAMPLE"
        ? "scale-down"
        : "cover";
    assert.equal(decision.object_fit, expectedFit, record.code);

    const surfaces = ["list", "detail", "related", "recently-viewed"].map(() =>
      resolveThumbnailPresentation({
        code: record.code,
        legacy_card_url: "/card-thumbnails/stale.jpg",
        legacy_thumbnail_url: "https://stale.invalid/image.jpg",
      })
    );
    assert.equal(new Set(surfaces.map((value) => JSON.stringify(value))).size, 1, record.code);
    const structured = thumbnailStructuredDataImage(surfaces[0], "https://preview.example.test");
    const expectedUrl = latest.output_path_or_url.startsWith("https://")
      ? latest.output_path_or_url
      : `https://preview.example.test${latest.output_path_or_url}`;
    assert.equal(structured.image, expectedUrl, record.code);
  }
});

test("Phase 4D preserves fixed canonical Phase 4B NON_RENDERABLE and SCENE_CROP controls", async () => {
  assert.equal(PRODUCTION_BASELINE_THUMBNAIL_DECISIONS.size, 79);
  assert.equal(PHASE4B_LEGACY_THUMBNAIL_DECISIONS.size, 796);
  assert.equal(PRODUCTION_THUMBNAIL_DECISIONS.size, 104);
  assert.equal(PRODUCTION_THUMBNAIL_REGISTRY_CONFLICTS.length, 0);
  assert.equal(
    [...PRODUCTION_THUMBNAIL_DECISIONS.values()].filter((value) => value.mode === "SCENE_CROP").length,
    29,
  );
  const exclusions = parseCsv(
    await readFile("data/thumbnail-phase4b-human-review-exclusions.csv", "utf8"),
  ).filter((row) => row.review_category === "NON_RENDERABLE");
  assert.equal(exclusions.length, 110);
  for (const row of exclusions) {
    assert.equal(getProductionThumbnailDecision(row.code), null, row.code);
    assert.equal(getPhase4BLegacyThumbnailDecision(row.code), null, row.code);
  }
  for (const record of GENERATED_PHASE4D_REVIEWED_DECISION_RECORDS) {
    assert.equal(PRODUCTION_BASELINE_THUMBNAIL_DECISIONS.has(record.code), false, record.code);
  }
});
