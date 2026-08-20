import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
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
  GENERATED_PHASE4C_REVIEWED_DECISION_RECORDS,
  GENERATED_PHASE4C_REVIEWED_STATS,
} from "../src/lib/thumbnail/generated-phase4c-reviewed-decisions.ts";
import {
  GENERATED_PHASE4D_REVIEWED_DECISION_RECORDS,
  GENERATED_PHASE4D_REVIEWED_STATS,
} from "../src/lib/thumbnail/generated-phase4d-reviewed-decisions.ts";
import {
  GENERATED_PHASE4E_REVIEWED_DECISION_RECORDS,
  GENERATED_PHASE4E_REVIEWED_STATS,
} from "../src/lib/thumbnail/generated-phase4e-reviewed-decisions.ts";
import {
  GENERATED_PHASE5_REVIEWED_DECISION_RECORDS,
  GENERATED_PHASE5_REVIEWED_STATS,
} from "../src/lib/thumbnail/generated-phase5-reviewed-decisions.ts";
import {
  getProductionThumbnailDecision,
  PRODUCTION_BASELINE_THUMBNAIL_DECISIONS,
  PRODUCTION_THUMBNAIL_DECISIONS,
  PRODUCTION_THUMBNAIL_REGISTRY_CONFLICTS,
  THUMBNAIL_PRODUCTION_REGISTRY_PRIORITY,
} from "../src/lib/thumbnail/production-registry.ts";
import {
  buildThumbnailRenderContract,
  resolveThumbnailPresentation,
} from "../src/lib/thumbnail/presentation.ts";
import {
  thumbnailStructuredDataImage,
} from "../src/lib/thumbnail/structured-data.ts";
import { parseCsv } from "../scripts/generate-thumbnail-production-registry.mjs";
import { loadThumbnailGoldLabels } from "../scripts/lib/thumbnail-gold-acceptance.mjs";

const sceneCropRows = parseCsv(
  await readFile("data/thumbnail-scene-crop-allowlist.csv", "utf8"),
);
const KEEP_CURRENT_CODES = [
  "1SBP00419",
  "1SBP00421",
  "AGEOM00035",
  "H_491KDMN00050",
  "H_491KDMN00051",
  "HMN00870",
  "MUDR00393",
];

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
    "phase4e_reviewed",
    "phase4d_reviewed",
    "phase4c_reviewed",
    "generated_human",
    "generated_gold",
    "phase5_reviewed",
  ]);
  assert.equal(PRODUCTION_THUMBNAIL_REGISTRY_CONFLICTS.length, 0);
  assert.equal(PRODUCTION_BASELINE_THUMBNAIL_DECISIONS.size, 79);
  assert.equal(PRODUCTION_THUMBNAIL_DECISIONS.size, 1382);
  assert.equal(GENERATED_PHASE5_REVIEWED_DECISION_RECORDS.length, 1278);
  assert.deepEqual(GENERATED_PHASE5_REVIEWED_STATS, {
    input_total: 1278,
    eligible_total: 1278,
    ignored_apply_false: 0,
  });
});

test("Phase 5 batch 02 appends exact human-reviewed provenance while preserving canary 30 bytes", async () => {
  const source = await readFile("data/thumbnail-phase5-reviewed-decisions.csv", "utf8");
  const lines = source.split("\n");
  const canaryPrefix = `${lines.slice(0, 31).join("\n")}\n`;
  assert.equal(
    crypto.createHash("sha256").update(canaryPrefix).digest("hex"),
    "f6faac86383466e9bc2e0a757af31bcaf84a022074e1443a01b56805ac45ccd0",
  );
  const canary = GENERATED_PHASE5_REVIEWED_DECISION_RECORDS.filter(
    (record) => record.approval_batch === "phase5f-canary-30",
  );
  const batch02 = GENERATED_PHASE5_REVIEWED_DECISION_RECORDS.filter(
    (record) => record.approval_batch === "phase5f-review-batch-02",
  );
  assert.equal(canary.length, 30);
  assert.equal(batch02.length, 116);
  assert.equal(new Set(batch02.map((record) => record.code)).size, 116);
  assert.deepEqual(
    batch02.reduce((counts, record) => {
      counts[record.mode] = (counts[record.mode] ?? 0) + 1;
      return counts;
    }, {}),
    { PACKAGE_CENTER: 4, PACKAGE_FULL: 17, PACKAGE_RIGHT: 86, SAMPLE: 9 },
  );
  for (const record of batch02) {
    assert.equal(record.approved_by, "owner_delegated_via_chatgpt", record.code);
    assert.equal(record.approval_batch, "phase5f-review-batch-02", record.code);
    assert.match(record.reason, /owner delegated proxy approval via ChatGPT/, record.code);
    assert.match(record.reason, /not an auto-safe classification/, record.code);
    if (record.mode === "SAMPLE") {
      const index = /^sample:([1-9]\d*)$/.exec(record.source_id)?.[1];
      assert.ok(index, record.code);
      assert.match(record.source_path_or_url, new RegExp(`jp-${index}\\.jpg$`, "i"), record.code);
      assert.equal(record.source_path_or_url, record.output_path_or_url, record.code);
      assert.equal(record.source_hash, record.output_hash, record.code);
    }
    if (record.mode === "PACKAGE_FULL") {
      assert.equal(record.source_id, "dvd:full", record.code);
      assert.equal(record.source_path_or_url, record.output_path_or_url, record.code);
      assert.equal(record.source_hash, record.output_hash, record.code);
    }
    if (record.mode === "PACKAGE_RIGHT") {
      assert.equal(record.source_id, "dvd:right", record.code);
      assert.equal(record.output_path_or_url, `/card-thumbnails/${record.code}-auto-right.jpg`, record.code);
    }
    if (record.mode === "PACKAGE_CENTER") {
      assert.equal(record.source_id, "dvd:center", record.code);
      assert.equal(record.output_path_or_url, `/card-thumbnails/${record.code}-auto-center.jpg`, record.code);
    }
  }
});

test("Phase 5 batch 03 appends only 203 delegated visual approvals and preserves the first 146 decisions byte-for-byte", async () => {
  const source = await readFile("data/thumbnail-phase5-reviewed-decisions.csv", "utf8");
  const lines = source.split("\n");
  const preservedPrefix = `${lines.slice(0, 147).join("\n")}\n`;
  assert.equal(
    crypto.createHash("sha256").update(preservedPrefix).digest("hex"),
    "99aea276b2109ee7b7638d23bbe753e4800287d0b9367e401f5b59bcd4407889",
  );
  const batch03 = GENERATED_PHASE5_REVIEWED_DECISION_RECORDS.filter(
    (record) => record.approval_batch === "phase5f-review-batch-03",
  );
  assert.equal(batch03.length, 203);
  assert.equal(new Set(batch03.map((record) => record.code)).size, 203);
  assert.deepEqual(
    batch03.reduce((counts, record) => {
      counts[record.mode] = (counts[record.mode] ?? 0) + 1;
      return counts;
    }, {}),
    { PACKAGE_CENTER: 3, PACKAGE_RIGHT: 191, SAMPLE: 9 },
  );
  for (const record of batch03) {
    assert.equal(record.approved_by, "owner_delegated_via_chatgpt", record.code);
    assert.equal(record.approval_batch, "phase5f-review-batch-03", record.code);
    assert.match(record.reason, /owner delegated proxy approval via ChatGPT/, record.code);
    assert.match(record.reason, /not an auto-safe classification/, record.code);
    if (record.mode === "SAMPLE") {
      const index = /^sample:([1-9]\d*)$/.exec(record.source_id)?.[1];
      assert.ok(index, record.code);
      assert.match(record.source_path_or_url, new RegExp(`jp-${index}\\.jpg$`, "i"), record.code);
      assert.equal(record.source_path_or_url, record.output_path_or_url, record.code);
      assert.equal(record.source_hash, record.output_hash, record.code);
    } else if (record.mode === "PACKAGE_RIGHT") {
      assert.equal(record.source_id, "dvd:right", record.code);
      assert.equal(record.output_path_or_url, `/card-thumbnails/${record.code}-auto-right.jpg`, record.code);
    } else {
      assert.equal(record.mode, "PACKAGE_CENTER", record.code);
      assert.equal(record.source_id, "dvd:center", record.code);
      assert.equal(record.output_path_or_url, `/card-thumbnails/${record.code}-auto-center.jpg`, record.code);
    }
  }
});

test("Phase 5 batch 04 appends exactly 343 visual approvals and preserves the existing 349 decisions byte-for-byte", async () => {
  const source = await readFile("data/thumbnail-phase5-reviewed-decisions.csv", "utf8");
  const lines = source.split("\n");
  const preservedPrefix = `${lines.slice(0, 350).join("\n")}\n`;
  assert.equal(
    crypto.createHash("sha256").update(preservedPrefix).digest("hex"),
    "14412b120621dce63970b16c1bb9f60f9c5774a532d47f21d67f18ce1f69f4b1",
  );
  const batch04 = GENERATED_PHASE5_REVIEWED_DECISION_RECORDS.filter(
    (record) => record.approval_batch === "phase5f-review-batch-04",
  );
  assert.equal(batch04.length, 343);
  assert.equal(new Set(batch04.map((record) => record.code)).size, 343);
  assert.deepEqual(
    batch04.reduce((counts, record) => {
      counts[record.mode] = (counts[record.mode] ?? 0) + 1;
      return counts;
    }, {}),
    { PACKAGE_CENTER: 5, PACKAGE_FULL: 2, PACKAGE_RIGHT: 323, SAMPLE: 13 },
  );
  for (const record of batch04) {
    assert.equal(record.approved_by, "owner_delegated_via_chatgpt", record.code);
    assert.equal(record.approval_batch, "phase5f-review-batch-04", record.code);
    assert.match(record.reason, /owner delegated proxy approval via ChatGPT/, record.code);
    assert.match(record.reason, /not an auto-safe classification/, record.code);
    const effective = getProductionThumbnailDecision(record.code);
    assert.equal(effective?.approval_status, "HUMAN_APPROVED", record.code);
    assert.equal(effective?.render_status, "READY", record.code);
    assert.equal(effective?.mode, record.mode, record.code);
    assert.equal(effective?.source_id, record.source_id, record.code);
    assert.equal(effective?.output_path_or_url, record.output_path_or_url, record.code);
    if (record.mode === "SAMPLE") {
      const index = /^sample:([1-9]\d*)$/.exec(record.source_id)?.[1];
      assert.ok(index, record.code);
      assert.match(record.source_path_or_url, new RegExp(`jp-${index}\\.jpg$`, "i"), record.code);
      assert.equal(record.source_path_or_url, record.output_path_or_url, record.code);
      assert.equal(record.source_hash, record.output_hash, record.code);
    } else if (record.mode === "PACKAGE_FULL") {
      assert.equal(record.source_id, "dvd:full", record.code);
      assert.equal(record.source_path_or_url, record.output_path_or_url, record.code);
      assert.equal(record.source_hash, record.output_hash, record.code);
    } else {
      const suffix = record.mode === "PACKAGE_RIGHT" ? "right" : "center";
      assert.equal(record.source_id, `dvd:${suffix}`, record.code);
      assert.equal(record.output_path_or_url, `/card-thumbnails/${record.code}-auto-${suffix}.jpg`, record.code);
      const bytes = await readFile(`public${record.output_path_or_url}`);
      assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), record.output_hash, record.code);
    }
  }
});

test("Phase 5 batch 05 appends exactly 586 delegated visual approvals and preserves the existing 692 decisions byte-for-byte", async () => {
  const source = await readFile("data/thumbnail-phase5-reviewed-decisions.csv", "utf8");
  const lines = source.split("\n");
  const preservedPrefix = `${lines.slice(0, 693).join("\n")}\n`;
  assert.equal(
    crypto.createHash("sha256").update(preservedPrefix).digest("hex"),
    "4796b6593f0e1756f0be6ee7bb1627f3bda2078d1dda7606f860e1bfedad087f",
  );
  const batch05 = GENERATED_PHASE5_REVIEWED_DECISION_RECORDS.filter(
    (record) => record.approval_batch === "phase5f-review-batch-05",
  );
  assert.equal(batch05.length, 586);
  assert.equal(new Set(batch05.map((record) => record.code)).size, 586);
  assert.deepEqual(
    batch05.reduce((counts, record) => {
      counts[record.mode] = (counts[record.mode] ?? 0) + 1;
      return counts;
    }, {}),
    { PACKAGE_CENTER: 11, PACKAGE_FULL: 69, PACKAGE_RIGHT: 471, SAMPLE: 35 },
  );
  for (const record of batch05) {
    assert.equal(record.approved_by, "owner_delegated_via_chatgpt", record.code);
    assert.equal(record.approval_batch, "phase5f-review-batch-05", record.code);
    assert.match(record.reason, /owner delegated proxy approval via ChatGPT/, record.code);
    assert.match(record.reason, /not an auto-safe classification/, record.code);
    const effective = getProductionThumbnailDecision(record.code);
    assert.equal(effective?.approval_status, "HUMAN_APPROVED", record.code);
    assert.equal(effective?.render_status, "READY", record.code);
    assert.equal(effective?.mode, record.mode, record.code);
    assert.equal(effective?.source_id, record.source_id, record.code);
    assert.equal(effective?.source_path_or_url, record.source_path_or_url, record.code);
    assert.equal(effective?.source_hash, record.source_hash, record.code);
    assert.equal(effective?.output_path_or_url, record.output_path_or_url, record.code);
    assert.equal(effective?.output_hash, record.output_hash, record.code);
    if (record.mode === "SAMPLE") {
      const index = /^sample:([1-9]\d*)$/.exec(record.source_id)?.[1];
      assert.ok(index, record.code);
      assert.match(record.source_path_or_url, new RegExp(`jp-${index}\\.jpg$`, "i"), record.code);
      assert.equal(record.source_path_or_url, record.output_path_or_url, record.code);
      assert.equal(record.source_hash, record.output_hash, record.code);
    } else if (record.mode === "PACKAGE_FULL") {
      assert.equal(record.source_id, "dvd:full", record.code);
      assert.equal(record.source_path_or_url, record.output_path_or_url, record.code);
      assert.equal(record.source_hash, record.output_hash, record.code);
    } else {
      const suffix = record.mode === "PACKAGE_RIGHT" ? "right" : "center";
      assert.equal(record.source_id, `dvd:${suffix}`, record.code);
      assert.equal(record.output_path_or_url, `/card-thumbnails/${record.code}-auto-${suffix}.jpg`, record.code);
      const bytes = await readFile(`public${record.output_path_or_url}`);
      assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), record.output_hash, record.code);
    }
  }
});

test("all generated records pass the canonical runtime validator", () => {
  for (const record of GENERATED_GOLD_DECISION_RECORDS) {
    assert.equal(assertCanonicalThumbnailDecision(adaptGoldLabelRecord(record)).code, record.code);
  }
  for (const record of GENERATED_HUMAN_DECISION_RECORDS) {
    assert.equal(assertCanonicalThumbnailDecision(adaptHumanApprovalRecord(record)).code, record.code);
  }
  for (const record of GENERATED_PHASE4C_REVIEWED_DECISION_RECORDS) {
    assert.equal(assertCanonicalThumbnailDecision(adaptHumanApprovalRecord(record)).code, record.code);
  }
  for (const record of GENERATED_PHASE4D_REVIEWED_DECISION_RECORDS) {
    assert.equal(assertCanonicalThumbnailDecision(adaptHumanApprovalRecord(record)).code, record.code);
  }
  for (const record of GENERATED_PHASE4E_REVIEWED_DECISION_RECORDS) {
    assert.equal(assertCanonicalThumbnailDecision(adaptHumanApprovalRecord(record)).code, record.code);
  }
  for (const record of GENERATED_PHASE5_REVIEWED_DECISION_RECORDS) {
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
    gold_pending: 0,
    gold_excluded_unsupported_mode: 36,
    gold_excluded_invalid_source: 0,
    human_total: 624,
    human_registry_adopted: 29,
    human_covered_by_fixed: 1,
    human_covered_by_scene_crop_allowlist: 29,
    human_excluded_current_ok: 77,
    human_excluded_pattern_or_cluster: 517,
    human_excluded_source_or_provenance: 0,
    alias_rejected: 0,
    duplicate_canonical_codes: 0,
    fixed_shadowed: 5,
    conflicts: 0,
    scene_crop_allowlist_total: 29,
    scene_crop_registry_adopted: 29,
    scene_crop_standard: 26,
    scene_crop_revised: 2,
    scene_crop_rotate_clockwise_b: 1,
  });
  assert.equal(GENERATED_HUMAN_DECISION_RECORDS.length, 29);
  assert.deepEqual(GENERATED_PHASE4C_REVIEWED_STATS, {
    total: 15,
    SAMPLE: 9,
    PACKAGE_RIGHT: 6,
  });
  assert.deepEqual(GENERATED_PHASE4D_REVIEWED_STATS, {
    total: 14,
    SAMPLE: 4,
    PACKAGE_RIGHT: 8,
    PACKAGE_FULL: 2,
    auto_applied: 0,
  });
  assert.deepEqual(GENERATED_PHASE4E_REVIEWED_STATS, {
    total: 4,
    SAMPLE: 4,
    auto_applied: 0,
  });
});

test("the explicit scene-crop allowlist is the only SCENE_CROP production source", () => {
  assert.equal(sceneCropRows.length, 29);
  const expectedCodes = sceneCropRows.map((row) => row.code).sort();
  const generatedSceneCrops = GENERATED_HUMAN_DECISION_RECORDS.filter(
    (record) => record.mode === "SCENE_CROP",
  );
  const productionSceneCrops = [...PRODUCTION_THUMBNAIL_DECISIONS.values()]
    .filter((decision) => decision.mode === "SCENE_CROP");
  assert.equal(generatedSceneCrops.length, 29);
  assert.equal(productionSceneCrops.length, 29);
  assert.deepEqual(
    sceneCropRows.reduce(
      (counts, row) => {
        const kind = {
          STANDARD: "normal",
          REVISED: "revised",
          ROTATE_CLOCKWISE_B: "rotated",
        }[row.crop_variant];
        assert.ok(kind, `${row.code}:${row.crop_variant}`);
        counts[kind] += 1;
        return counts;
      },
      { normal: 0, revised: 0, rotated: 0 },
    ),
    { normal: 26, revised: 2, rotated: 1 },
  );
  const rotatedRow = sceneCropRows.find((row) => row.code === "1SBP00424");
  assert.ok(rotatedRow);
  assert.equal(rotatedRow.crop_variant, "ROTATE_CLOCKWISE_B");
  assert.deepEqual(JSON.parse(rotatedRow.crop_spec), {
    unit: "pixel",
    x: 0,
    y: 0,
    width: 385,
    height: 550,
    rotation_degrees: 90,
  });
  assert.equal(
    rotatedRow.source_hash,
    "644bf16443157666f9a8433e318eac87248339cc56150b51875cde7dfecf3540",
  );
  assert.equal(
    rotatedRow.output_hash,
    "160f809f1fee99f77fd9716050a12946289ec0534ee7f28727f88b3a0fa62984",
  );
  assert.deepEqual(
    generatedSceneCrops.map((record) => record.code).sort(),
    expectedCodes,
  );
  assert.deepEqual(
    productionSceneCrops.map((decision) => decision.code).sort(),
    expectedCodes,
  );

  for (const row of sceneCropRows) {
    assert.match(
      row.source_local_path,
      new RegExp(
        `^data/thumbnail-scene-crop-sources/${row.code}-scene-pl-${row.source_hash.slice(0, 16)}\\.jpg$`,
      ),
      row.code,
    );
    assert.equal(row.source_local_path.includes("tmp/"), false, row.code);
    const decision = getProductionThumbnailDecision(row.code);
    assert.ok(decision, row.code);
    assert.equal(decision.kind, "RESOLVED", row.code);
    assert.equal(decision.mode, "SCENE_CROP", row.code);
    assert.equal(decision.source_id, row.source_id, row.code);
    assert.equal(decision.source_kind, "SCENE", row.code);
    assert.equal(decision.source_path_or_url, row.source_path_or_url, row.code);
    assert.equal(decision.source_hash, row.source_hash, row.code);
    assert.equal(decision.output_path_or_url, row.output_path_or_url, row.code);
    assert.equal(decision.output_hash, row.output_hash, row.code);
    assert.equal(row.object_fit, "scale-down", row.code);
    assert.equal(decision.object_fit, "scale-down", row.code);
    assert.deepEqual(decision.crop_spec, JSON.parse(row.crop_spec), row.code);
    assert.equal(decision.approval_status, "HUMAN_APPROVED", row.code);
    assert.equal(decision.render_status, "READY", row.code);
    assert.equal(decision.approved_by, row.approved_by, row.code);
    assert.equal(decision.approved_at, row.approved_at, row.code);
    assert.equal(decision.reason, row.reason, row.code);
    assert.equal(JSON.stringify(decision).includes("tmp/"), false, row.code);
    const generatedRecord = GENERATED_HUMAN_DECISION_RECORDS.find(
      (record) => record.code === row.code,
    );
    assert.ok(generatedRecord, row.code);
    assert.equal(Object.hasOwn(generatedRecord, "source_local_path"), false, row.code);

    const crop = JSON.parse(row.crop_spec);
    if (row.crop_variant === "ROTATE_CLOCKWISE_B") {
      assert.equal(row.code, "1SBP00424");
      assert.equal(crop.rotation_degrees, 90);
    } else {
      assert.equal(crop.rotation_degrees ?? 0, 0, row.code);
    }

    const input = {
      code: row.code,
      legacy_card_url: "/card-thumbnails/stale.jpg",
      legacy_thumbnail_url: "https://pics.dmm.co.jp/stale.jpg",
    };
    const surfaces = ["list", "detail", "related", "recently-viewed"].map(() =>
      resolveThumbnailPresentation(input)
    );
    for (const resolution of surfaces) {
      assert.equal(resolution.resolution_kind, "CANONICAL", row.code);
      assert.equal(resolution.resolved_url, row.output_path_or_url, row.code);
      assert.equal(resolution.mode, "SCENE_CROP", row.code);
      assert.equal(resolution.object_fit, "scale-down", row.code);
      assert.deepEqual(resolution.crop_spec, JSON.parse(row.crop_spec), row.code);
      const contract = buildThumbnailRenderContract(resolution);
      assert.equal(contract.object_fit, "scale-down", row.code);
      assert.equal(contract.object_position, "center", row.code);
      assert.deepEqual(contract.crop_spec, JSON.parse(row.crop_spec), row.code);
    }
    const structured = thumbnailStructuredDataImage(
      surfaces[0],
      new URL("https://example.test"),
    );
    assert.equal(
      structured.image,
      `https://example.test${row.output_path_or_url}`,
      row.code,
    );
  }
});

test("READY decisions use one mode-level object-fit contract", () => {
  const counts = [...PRODUCTION_THUMBNAIL_DECISIONS.values()].reduce(
    (result, decision) => {
      if (decision.render_status !== "READY") return result;
      const key = `${decision.mode}|${decision.object_fit}`;
      result[key] = (result[key] ?? 0) + 1;
      return result;
    },
    {},
  );
  assert.deepEqual(counts, {
    "SAMPLE|scale-down": 93,
    "PACKAGE_RIGHT|cover": 1114,
    "PACKAGE_FULL|contain": 102,
    "SCENE_FULL|contain": 1,
    "SCENE_CROP|scale-down": 29,
    "PACKAGE_CENTER|cover": 43,
  });
});

test("keep-current approvals remain outside the canonical registry", () => {
  for (const code of KEEP_CURRENT_CODES) {
    assert.equal(getProductionThumbnailDecision(code), null, code);
    const result = resolveThumbnailPresentation({
      code,
      legacy_card_url: `/card-thumbnails/${code}-legacy.jpg`,
    });
    assert.equal(result.resolution_kind, "LEGACY_COMPAT", code);
  }
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
  assert.equal(decision.object_fit, "scale-down");
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
