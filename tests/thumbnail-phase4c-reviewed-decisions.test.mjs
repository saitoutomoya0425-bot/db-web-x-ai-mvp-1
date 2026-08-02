import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  GENERATED_PHASE4C_REVIEWED_DECISION_RECORDS,
  GENERATED_PHASE4C_REVIEWED_INPUT_SHA256,
  GENERATED_PHASE4C_REVIEWED_STATS,
} from "../src/lib/thumbnail/generated-phase4c-reviewed-decisions.ts";
import {
  getProductionThumbnailDecision,
  PRODUCTION_BASELINE_THUMBNAIL_DECISIONS,
  PRODUCTION_THUMBNAIL_DECISIONS,
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

const DATA_PATH = "data/thumbnail-phase4c-reviewed-decisions.csv";
const DECISIONS = Object.freeze({
  DSOD00029: ["PACKAGE_RIGHT", "dvd:right"],
  DVMM00422: ["PACKAGE_RIGHT", "dvd:right"],
  DVMM00423: ["PACKAGE_RIGHT", "dvd:right"],
  H_237NACT00155: ["PACKAGE_RIGHT", "dvd:right"],
  H_237NACT00158: ["PACKAGE_RIGHT", "dvd:right"],
  H_237NACT00159: ["PACKAGE_RIGHT", "dvd:right"],
  KIWVR00907: ["SAMPLE", "sample:2"],
  KSBJ00438: ["SAMPLE", "sample:5"],
  LUCY00029: ["SAMPLE", "sample:3"],
  MUDR00386: ["SAMPLE", "sample:5"],
  NATR00771: ["SAMPLE", "sample:1"],
  NIMA00081: ["SAMPLE", "sample:18"],
  UMSO00649: ["SAMPLE", "sample:1"],
  UMSO00650: ["SAMPLE", "sample:9"],
  VRKM01857: ["SAMPLE", "sample:1"],
});
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const dataBytes = await readFile(DATA_PATH);
const rows = parseCsv(dataBytes.toString("utf8"));
const rowsByCode = new Map(rows.map((row) => [row.code, row]));

test("Phase 4C data records exactly the 15 user-approved apply=true decisions", () => {
  assert.equal(rows.length, 15);
  assert.equal(rowsByCode.size, 15);
  assert.equal(GENERATED_PHASE4C_REVIEWED_DECISION_RECORDS.length, 15);
  assert.deepEqual(GENERATED_PHASE4C_REVIEWED_STATS, {
    total: 15,
    SAMPLE: 9,
    PACKAGE_RIGHT: 6,
  });
  assert.equal(GENERATED_PHASE4C_REVIEWED_INPUT_SHA256, sha256(dataBytes));
  assert.deepEqual(
    [...rowsByCode.keys()].sort(),
    Object.keys(DECISIONS).sort(),
  );
  for (const [code, [mode, sourceId]] of Object.entries(DECISIONS)) {
    const row = rowsByCode.get(code);
    assert.ok(row, code);
    assert.equal(row.apply, "true", code);
    assert.equal(row.mode, mode, code);
    assert.equal(row.source_id, sourceId, code);
    assert.equal(row.approved_by, "USER_HANDOFF", code);
    assert.equal(row.approved_at, "2026-08-02", code);
    assert.equal(row.source_hash, row.output_hash, code);
  }
});

test("Phase 4C fixes mode source URL and both provenance hashes atomically", async () => {
  for (const record of GENERATED_PHASE4C_REVIEWED_DECISION_RECORDS) {
    const row = rowsByCode.get(record.code);
    assert.ok(row, record.code);
    for (const field of [
      "mode",
      "source_id",
      "source_path_or_url",
      "source_hash",
      "output_path_or_url",
      "output_hash",
      "approved_by",
      "approved_at",
      "reason",
    ]) {
      assert.equal(record[field], row[field], `${record.code}:${field}`);
    }
    assert.equal(record.state, "RESOLVED", record.code);
    assert.equal(record.crop_spec, null, record.code);

    if (record.mode === "PACKAGE_RIGHT") {
      const bytes = await readFile(record.source_path_or_url);
      assert.equal(sha256(bytes), record.source_hash, record.code);
      assert.equal(record.output_path_or_url, `/${record.source_path_or_url.slice("public/".length)}`, record.code);
    } else {
      assert.equal(record.source_path_or_url, record.output_path_or_url, record.code);
      const sampleNumber = record.source_id.slice("sample:".length);
      const slug = record.code.toLowerCase();
      assert.equal(
        record.source_path_or_url,
        `https://pics.dmm.co.jp/digital/video/${slug}/${slug}jp-${sampleNumber}.jpg`,
        record.code,
      );
    }
  }
});

test("all 15 Phase 4C works retain their approved production resolution", () => {
  for (const [code, [mode, sourceId]] of Object.entries(DECISIONS)) {
    const input = {
      code,
      legacy_runtime_override: {
        path: "/card-thumbnails/stale-runtime.jpg",
        mode: "full",
        source_id: "dvd:full",
        output_hash: null,
      },
      legacy_card_url: "/card-thumbnails/stale-card.jpg",
      legacy_thumbnail_url: "https://pics.dmm.co.jp/stale-thumbnail.jpg",
    };
    const surfaces = ["list", "detail", "related", "recently-viewed"].map(() =>
      resolveThumbnailPresentation(input)
    );
    assert.equal(new Set(surfaces.map((value) => JSON.stringify(value))).size, 1, code);
    const resolution = surfaces[0];
    const decision = getProductionThumbnailDecision(code);
    assert.ok(decision, code);
    assert.equal(resolution.resolution_kind, "CANONICAL", code);
    assert.equal(resolution.mode, mode, code);
    assert.equal(resolution.source_id, sourceId, code);
    assert.equal(resolution.resolved_url, decision.output_path_or_url, code);
    assert.equal(resolution.approval_status, "HUMAN_APPROVED", code);
    assert.equal(resolution.render_status, "READY", code);
    assert.equal(resolution.source_hash, decision.source_hash, code);
    assert.equal(resolution.output_hash, decision.output_hash, code);
    assert.equal(resolution.crop_spec, null, code);
    const contract = buildThumbnailRenderContract(resolution);
    assert.equal(contract.src, decision.output_path_or_url, code);
    assert.equal(contract.object_fit, "cover", code);
    assert.equal(contract.object_position, "center", code);
    const structured = thumbnailStructuredDataImage(resolution, "https://preview.example.test");
    const expected = decision.output_path_or_url.startsWith("https://")
      ? decision.output_path_or_url
      : `https://preview.example.test${decision.output_path_or_url}`;
    assert.equal(structured.image, expected, code);
  }
});

test("Phase 4C audit history remains while the combined reviewed registry has 104 unique works", () => {
  assert.equal(PRODUCTION_BASELINE_THUMBNAIL_DECISIONS.size, 79);
  assert.equal(PHASE4B_LEGACY_THUMBNAIL_DECISIONS.size, 796);
  assert.equal(PRODUCTION_THUMBNAIL_DECISIONS.size, 104);
  for (const code of Object.keys(DECISIONS)) {
    assert.equal(PRODUCTION_BASELINE_THUMBNAIL_DECISIONS.has(code), false, code);
    assert.equal(getPhase4BLegacyThumbnailDecision(code), null, code);
    assert.ok(getProductionThumbnailDecision(code), code);
  }
});

test("the 110 NON_RENDERABLE exclusions remain without canonical or Phase 4B resolution", async () => {
  const exclusions = parseCsv(
    await readFile("data/thumbnail-phase4b-human-review-exclusions.csv", "utf8"),
  ).filter((row) => row.review_category === "NON_RENDERABLE");
  assert.equal(exclusions.length, 110);
  for (const row of exclusions) {
    assert.equal(getProductionThumbnailDecision(row.code), null, row.code);
    assert.equal(getPhase4BLegacyThumbnailDecision(row.code), null, row.code);
  }
});
