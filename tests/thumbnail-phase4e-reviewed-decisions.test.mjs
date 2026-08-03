import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  GENERATED_PHASE4C_REVIEWED_DECISION_RECORDS,
} from "../src/lib/thumbnail/generated-phase4c-reviewed-decisions.ts";
import {
  GENERATED_PHASE4D_REVIEWED_DECISION_RECORDS,
} from "../src/lib/thumbnail/generated-phase4d-reviewed-decisions.ts";
import {
  GENERATED_PHASE4E_REVIEWED_DECISION_RECORDS,
  GENERATED_PHASE4E_REVIEWED_INPUT_SHA256,
  GENERATED_PHASE4E_REVIEWED_STATS,
} from "../src/lib/thumbnail/generated-phase4e-reviewed-decisions.ts";
import {
  getProductionThumbnailDecision,
  PRODUCTION_BASELINE_THUMBNAIL_DECISIONS,
  PRODUCTION_THUMBNAIL_DECISIONS,
  PRODUCTION_THUMBNAIL_REGISTRY_CONFLICTS,
} from "../src/lib/thumbnail/production-registry.ts";
import {
  buildThumbnailRenderContract,
  resolveThumbnailPresentation,
} from "../src/lib/thumbnail/presentation.ts";
import { thumbnailStructuredDataImage } from "../src/lib/thumbnail/structured-data.ts";
import { parseCsv } from "../scripts/generate-thumbnail-production-registry.mjs";

const DATA_PATH = "data/thumbnail-phase4e-reviewed-decisions.csv";
const LABEL_PATH = "data/thumbnail-phase4e-ranking-labels.csv";
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const dataBytes = await readFile(DATA_PATH);
const rows = parseCsv(dataBytes.toString("utf8"));
const labels = parseCsv(await readFile(LABEL_PATH, "utf8"));
const recordsByCode = new Map(
  GENERATED_PHASE4E_REVIEWED_DECISION_RECORDS.map((record) => [record.code, record]),
);
const expected = Object.freeze({
  KIWVR00907: [
    "https://pics.dmm.co.jp/digital/video/kiwvr00907/kiwvr00907jp-1.jpg",
    "6617d270aaca3b1072f2537894ef854d972dde127094c7d717ddff6981cdacf8",
    588,
    800,
  ],
  KSBJ00438: [
    "https://pics.dmm.co.jp/digital/video/ksbj00438/ksbj00438jp-1.jpg",
    "e2bf85d60b077c2b269d3a7a40f7c9082ba299e712f783ff9948d21c4f890ec6",
    565,
    800,
  ],
  LUCY00029: [
    "https://pics.dmm.co.jp/digital/video/lucy00029/lucy00029jp-1.jpg",
    "428ed0e1dc8c0714c371672f5287b4c1cfcc67561d52740f9ec10e5b6867c203",
    565,
    800,
  ],
  UMSO00650: [
    "https://pics.dmm.co.jp/digital/video/umso00650/umso00650jp-1.jpg",
    "03bf532f7aae96fc466c825558af559ff6ac30aa61c0ce285b77bda84ad4fb21",
    565,
    800,
  ],
});
const negativeSources = Object.freeze({
  KIWVR00907: ["sample:2", "sample:4"],
  KSBJ00438: ["sample:5", "sample:6"],
  LUCY00029: ["sample:3", "sample:6"],
  UMSO00650: ["sample:9", "sample:18"],
});

test("Phase 4E records exactly four explicit sample:1 user decisions", async () => {
  assert.equal(rows.length, 4);
  assert.equal(recordsByCode.size, 4);
  assert.deepEqual(GENERATED_PHASE4E_REVIEWED_STATS, {
    total: 4,
    SAMPLE: 4,
    auto_applied: 0,
  });
  assert.equal(GENERATED_PHASE4E_REVIEWED_INPUT_SHA256, sha256(dataBytes));

  for (const row of rows) {
    const [url, hash, width, height] = expected[row.code] ?? [];
    assert.ok(url, row.code);
    assert.equal(row.mode, "SAMPLE", row.code);
    assert.equal(row.source_id, "sample:1", row.code);
    assert.equal(row.source_kind, "SAMPLE", row.code);
    assert.equal(row.source_path_or_url, url, row.code);
    assert.equal(row.output_path_or_url, url, row.code);
    assert.equal(row.source_hash, hash, row.code);
    assert.equal(row.output_hash, hash, row.code);
    assert.equal(Number(row.source_width), width, row.code);
    assert.equal(Number(row.source_height), height, row.code);
    assert.equal(row.object_fit, "cover", row.code);
    assert.equal(row.crop_spec, "null", row.code);
    assert.equal(row.approval_status, "HUMAN_APPROVED", row.code);
    assert.equal(row.render_status, "READY", row.code);
    assert.equal(row.approved_by, "USER_HANDOFF", row.code);
    assert.equal(row.approved_at, "2026-08-03", row.code);
    assert.equal(row.approval_batch, "PHASE_4E_USER_REVIEW", row.code);
    assert.equal(row.apply, "true", row.code);
    const local = await readFile(row.source_local_path);
    assert.equal(sha256(local), hash, row.code);
  }
});

test("Phase 4E positive and negative teacher labels are exact and never auto-apply", () => {
  assert.equal(labels.length, 12);
  assert.equal(labels.filter((row) => row.label === "POSITIVE").length, 4);
  assert.equal(labels.filter((row) => row.label === "NEGATIVE").length, 8);
  assert.equal(labels.filter((row) => row.apply === "true").length, 0);
  for (const [code, [url, hash]] of Object.entries(expected)) {
    const positive = labels.find((row) => row.code === code && row.label === "POSITIVE");
    assert.ok(positive, code);
    assert.equal(positive.source_id, "sample:1", code);
    assert.equal(positive.source_path_or_url, url, code);
    assert.equal(positive.source_hash, hash, code);
    assert.deepEqual(
      labels
        .filter((row) => row.code === code && row.label === "NEGATIVE")
        .map((row) => row.source_id)
        .sort(),
      [...negativeSources[code]].sort(),
      code,
    );
  }
});

test("Phase 4E supersedes Phase 4C and Phase 4D without deleting their audit rows", () => {
  const phase4C = new Map(
    GENERATED_PHASE4C_REVIEWED_DECISION_RECORDS.map((record) => [record.code, record]),
  );
  const phase4D = new Map(
    GENERATED_PHASE4D_REVIEWED_DECISION_RECORDS.map((record) => [record.code, record]),
  );
  for (const code of Object.keys(expected)) {
    assert.ok(phase4C.has(code), code);
    assert.ok(phase4D.has(code), code);
    assert.ok(negativeSources[code].includes(phase4C.get(code).source_id), code);
    assert.ok(negativeSources[code].includes(phase4D.get(code).source_id), code);
    assert.equal(getProductionThumbnailDecision(code)?.source_id, "sample:1", code);
  }
});

test("all public surfaces and structured data use one Phase 4E URL", () => {
  for (const [code, [url, hash]] of Object.entries(expected)) {
    const decision = getProductionThumbnailDecision(code);
    assert.ok(decision, code);
    assert.equal(decision.mode, "SAMPLE", code);
    assert.equal(decision.source_id, "sample:1", code);
    assert.equal(decision.source_kind, "SAMPLE", code);
    assert.equal(decision.source_path_or_url, url, code);
    assert.equal(decision.output_path_or_url, url, code);
    assert.equal(decision.source_hash, hash, code);
    assert.equal(decision.output_hash, hash, code);
    assert.equal(decision.object_fit, "cover", code);
    assert.equal(decision.crop_spec, null, code);
    assert.equal(decision.approval_status, "HUMAN_APPROVED", code);
    assert.equal(decision.render_status, "READY", code);
    assert.equal(decision.approved_by, "USER_HANDOFF", code);
    assert.equal(decision.approved_at, "2026-08-03", code);
    assert.equal(decision.approval_batch, "PHASE_4E_USER_REVIEW", code);

    const input = {
      code,
      legacy_runtime_override: {
        path: `/card-thumbnails/${code}-auto-right.jpg`,
        mode: "right",
        source_id: "dvd:right",
        output_hash: null,
      },
      legacy_card_url: `https://db.invalid/${code}.jpg`,
      legacy_thumbnail_url: `https://pics.dmm.co.jp/digital/video/${code.toLowerCase()}/${code.toLowerCase()}jp-99.jpg`,
    };
    const surfaces = ["list", "search", "detail", "related", "recently-viewed"].map(() =>
      resolveThumbnailPresentation(input)
    );
    assert.equal(new Set(surfaces.map((value) => JSON.stringify(value))).size, 1, code);
    for (const resolution of surfaces) {
      assert.equal(resolution.resolution_kind, "CANONICAL", code);
      assert.equal(resolution.mode, "SAMPLE", code);
      assert.equal(resolution.source_id, "sample:1", code);
      assert.equal(resolution.resolved_url, url, code);
      assert.equal(resolution.object_fit, "cover", code);
      for (const rejected of negativeSources[code]) {
        assert.notEqual(resolution.source_id, rejected, code);
      }
    }
    const contract = buildThumbnailRenderContract(surfaces[0]);
    assert.equal(contract.src, url, code);
    assert.equal(contract.object_fit, "cover", code);
    assert.equal(contract.object_position, "center", code);
    assert.equal(thumbnailStructuredDataImage(surfaces[0], "https://preview.example.test").image, url, code);
  }
});

test("Phase 4E changes no registry population controls", async () => {
  assert.equal(PRODUCTION_BASELINE_THUMBNAIL_DECISIONS.size, 79);
  assert.equal(PRODUCTION_THUMBNAIL_DECISIONS.size, 104);
  assert.equal(PRODUCTION_THUMBNAIL_REGISTRY_CONFLICTS.length, 0);
  assert.equal(
    [...PRODUCTION_THUMBNAIL_DECISIONS.values()].filter((decision) => decision.mode === "SCENE_CROP").length,
    29,
  );
  const exclusions = parseCsv(
    await readFile("data/thumbnail-phase4b-human-review-exclusions.csv", "utf8"),
  ).filter((row) => row.review_category === "NON_RENDERABLE");
  assert.equal(exclusions.length, 110);
  for (const row of exclusions) {
    assert.equal(getProductionThumbnailDecision(row.code), null, row.code);
  }
  for (const record of GENERATED_PHASE4D_REVIEWED_DECISION_RECORDS) {
    if (recordsByCode.has(record.code)) continue;
    const decision = getProductionThumbnailDecision(record.code);
    assert.ok(decision, record.code);
    assert.equal(decision.mode, record.mode, record.code);
    assert.equal(decision.source_id, record.source_id, record.code);
    assert.equal(decision.output_path_or_url, record.output_path_or_url, record.code);
  }
});
