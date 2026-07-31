import test from "node:test";
import assert from "node:assert/strict";
import {
  adaptGoldLabelRecord,
  adaptHumanApprovalRecord,
} from "../src/lib/thumbnail/adapters.ts";
import { assertCanonicalThumbnailDecision } from "../src/lib/thumbnail/contract.ts";
import { PRODUCTION_CANONICAL_THUMBNAIL_DECISIONS } from "../src/lib/thumbnail/canonical-decisions.ts";
import {
  GENERATED_APPROVED_REGISTRY_STATS,
  GENERATED_GOLD_DECISION_RECORDS,
  GENERATED_HUMAN_DECISION_RECORDS,
} from "../src/lib/thumbnail/generated-approved-decisions.ts";
import {
  getProductionThumbnailDecision,
  PRODUCTION_THUMBNAIL_DECISIONS,
  PRODUCTION_THUMBNAIL_REGISTRY_CONFLICTS,
  THUMBNAIL_PRODUCTION_REGISTRY_PRIORITY,
} from "../src/lib/thumbnail/production-registry.ts";
import { resolveThumbnailPresentation } from "../src/lib/thumbnail/presentation.ts";
import { loadThumbnailGoldLabels } from "../scripts/lib/thumbnail-gold-acceptance.mjs";

const MODE_MAP = {
  sample: "SAMPLE",
  right: "PACKAGE_RIGHT",
  full: "PACKAGE_FULL",
  center: "PACKAGE_CENTER",
};
const SOURCE_PATTERNS = {
  SAMPLE: /^sample:[1-9]\d*$/,
  PACKAGE_RIGHT: /^dvd:right$/,
  PACKAGE_FULL: /^dvd:full$/,
  PACKAGE_CENTER: /^dvd:center$/,
};
const productionSourceId = (code, sourceId) =>
  code === "DSVR00064" && sourceId === "sample:1_high_resolution"
    ? "sample:1"
    : sourceId;

test("production registry applies one explicit precedence without conflicts", () => {
  assert.deepEqual(THUMBNAIL_PRODUCTION_REGISTRY_PRIORITY, [
    "fixed_canonical",
    "generated_human",
    "generated_gold",
  ]);
  assert.equal(PRODUCTION_THUMBNAIL_REGISTRY_CONFLICTS.length, 0);
  assert.equal(PRODUCTION_THUMBNAIL_DECISIONS.size, 50);
});

test("all generated records pass the canonical runtime validator", () => {
  for (const record of GENERATED_GOLD_DECISION_RECORDS) {
    assert.equal(assertCanonicalThumbnailDecision(adaptGoldLabelRecord(record)).code, record.code);
  }
  for (const record of GENERATED_HUMAN_DECISION_RECORDS) {
    assert.equal(assertCanonicalThumbnailDecision(adaptHumanApprovalRecord(record)).code, record.code);
  }
});

test("every canonical-compatible gold row is connected with exact mode and source ID", async () => {
  const labels = await loadThumbnailGoldLabels();
  const valid = [...labels.values()].flatMap((label) => {
    const mode = MODE_MAP[label.type];
    const sourceId = productionSourceId(label.productCode, label.source);
    return mode && SOURCE_PATTERNS[mode].test(sourceId)
      ? [{ ...label, sourceId }]
      : [];
  });
  assert.equal(labels.size, 83);
  assert.equal(valid.length, 47);
  assert.equal(GENERATED_GOLD_DECISION_RECORDS.length, valid.length);

  for (const label of valid) {
    const decision = getProductionThumbnailDecision(label.productCode);
    assert.ok(decision, label.productCode);
    assert.equal(decision.mode, MODE_MAP[label.type], label.productCode);
    assert.equal(decision.source_id, label.sourceId, label.productCode);
  }
});

test("generated registry metadata proves conservative human approval selection", () => {
  assert.deepEqual(GENERATED_APPROVED_REGISTRY_STATS, {
    gold_total: 83,
    gold_registry_adopted: 47,
    gold_pending: 1,
    gold_excluded_unsupported_mode: 36,
    gold_excluded_invalid_source: 0,
    human_total: 624,
    human_registry_adopted: 0,
    human_covered_by_fixed: 1,
    human_excluded_current_ok: 103,
    human_excluded_pattern_or_cluster: 520,
    human_excluded_source_or_provenance: 0,
    alias_rejected: 0,
    duplicate_canonical_codes: 0,
    fixed_shadowed: 5,
    conflicts: 0,
  });
  assert.equal(GENERATED_HUMAN_DECISION_RECORDS.length, 0);
});

test("DSVR00064 uses only its approved high-resolution sample as canonical sample:1", () => {
  const decision = getProductionThumbnailDecision("DSVR00064");
  assert.ok(decision);
  assert.equal(decision.mode, "SAMPLE");
  assert.equal(decision.source_id, "sample:1");
  assert.equal(decision.source_kind, "SAMPLE");
  assert.equal(
    decision.source_path_or_url,
    "public/card-thumbnails/DSVR00064-sample-v4.jpg",
  );
  assert.equal(
    decision.output_path_or_url,
    "/card-thumbnails/DSVR00064-sample-v4.jpg",
  );
  assert.equal(
    decision.source_hash,
    "086ddbb754966cf33790c177daf4cca2b24a81c3ecf996888ba9c437850e3ff3",
  );
  assert.equal(decision.output_hash, decision.source_hash);
  assert.equal(decision.approval_status, "GOLD_APPROVED");
  assert.equal(decision.render_status, "READY");
  assert.equal(decision.object_fit, "cover");
  assert.equal(decision.crop_spec, null);
  assert.match(decision.reason, /raw_source_id=sample:1_high_resolution/);

  const result = resolveThumbnailPresentation({
    code: "DSVR00064",
    legacy_runtime_override: {
      path: "/card-thumbnails/stale.jpg",
      mode: "right",
      source_id: "dvd:right",
      output_hash: "a".repeat(64),
    },
    legacy_card_url: "/card-thumbnails/stale.jpg",
    legacy_thumbnail_url: "https://pics.dmm.co.jp/stale.jpg",
  });
  assert.equal(result.resolution_kind, "CANONICAL");
  assert.equal(result.approval_status, "GOLD_APPROVED");
  assert.equal(result.render_status, "READY");
  assert.equal(result.resolved_url, "/card-thumbnails/DSVR00064-sample-v4.jpg");
});

test("the fixed eight always override matching generated records", () => {
  assert.equal(PRODUCTION_CANONICAL_THUMBNAIL_DECISIONS.size, 8);
  for (const [code, fixed] of PRODUCTION_CANONICAL_THUMBNAIL_DECISIONS) {
    assert.equal(getProductionThumbnailDecision(code), fixed, code);
  }
});

test("six reviewed regressions resolve as exact gold canonical decisions", () => {
  const expected = {
    "13DSVR01990": [
      "SAMPLE",
      "sample:1",
      "/card-thumbnails/13DSVR01990-gold-sample-1.jpg",
    ],
    "RBB00339": [
      "PACKAGE_RIGHT",
      "dvd:right",
      "/card-thumbnails/RBB00339-auto-right.jpg",
    ],
    "H_1784FTO00061": [
      "PACKAGE_FULL",
      "dvd:full",
      "/card-thumbnails/H_1784FTO00061-gold-full.jpg",
    ],
    "1VRNC00096": [
      "PACKAGE_CENTER",
      "dvd:center",
      "/card-thumbnails/1VRNC00096-auto-center.jpg",
    ],
    "1FCDSS00115": [
      "PACKAGE_RIGHT",
      "dvd:right",
      "/card-thumbnails/1FCDSS00115-auto-right.jpg",
    ],
    "BEBL00058": [
      "SAMPLE",
      "sample:4",
      "https://pics.dmm.co.jp/digital/video/bebl00058/bebl00058jp-4.jpg",
    ],
  };

  for (const [code, [mode, sourceId, output]] of Object.entries(expected)) {
    const result = resolveThumbnailPresentation({
      code,
      legacy_runtime_override: {
        path: "/card-thumbnails/stale.jpg",
        mode: "right",
        source_id: "dvd:right",
        output_hash: "a".repeat(64),
      },
      legacy_card_url: "/card-thumbnails/stale.jpg",
      legacy_thumbnail_url: "https://pics.dmm.co.jp/stale.jpg",
    });
    assert.equal(result.resolution_kind, "CANONICAL", code);
    assert.equal(result.approval_status, "GOLD_APPROVED", code);
    assert.equal(result.render_status, "READY", code);
    assert.equal(result.mode, mode, code);
    assert.equal(result.source_id, sourceId, code);
    assert.equal(result.resolved_url, output, code);
    assert.match(result.source_hash, /^[a-f0-9]{64}$/, code);
    assert.match(result.output_hash, /^[a-f0-9]{64}$/, code);
  }
});

test("canonical aliases do not create duplicate registry entries", () => {
  const alias62 = getProductionThumbnailDecision("H_1784FT000062");
  const canonical62 = getProductionThumbnailDecision("H_1784FTO00062");
  const alias64 = getProductionThumbnailDecision("H_1784FT000064");
  const canonical64 = getProductionThumbnailDecision("H_1784FTO00064");
  assert.equal(alias62, canonical62);
  assert.equal(alias64, canonical64);
  assert.equal(PRODUCTION_THUMBNAIL_DECISIONS.has("H_1784FT000062"), false);
  assert.equal(PRODUCTION_THUMBNAIL_DECISIONS.has("H_1784FT000064"), false);
  assert.equal(getProductionThumbnailDecision("1NAMH500006"), null);
});
