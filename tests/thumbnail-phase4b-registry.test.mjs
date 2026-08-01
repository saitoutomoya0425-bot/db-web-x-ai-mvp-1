import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  GENERATED_PHASE4B_LEGACY_RECORDS,
  GENERATED_PHASE4B_LEGACY_STATS,
} from "../src/lib/thumbnail/generated-phase4b-legacy-registry.ts";
import {
  getPhase4BLegacyThumbnailDecision,
  PHASE4B_LEGACY_THUMBNAIL_DECISIONS,
} from "../src/lib/thumbnail/phase4b-legacy-registry.ts";
import {
  PRODUCTION_THUMBNAIL_DECISIONS,
  getProductionThumbnailDecision,
} from "../src/lib/thumbnail/production-registry.ts";
import {
  buildThumbnailRenderContract,
  resolveThumbnailPresentation,
  THUMBNAIL_PRESENTATION_PRIORITY,
} from "../src/lib/thumbnail/presentation.ts";
import { thumbnailStructuredDataImage } from "../src/lib/thumbnail/structured-data.ts";
import { parseCsv } from "../scripts/generate-thumbnail-phase4b-legacy-registry.mjs";

const EXPECTED_CANONICAL_SHA256 = "2f906c24c1deefb7c955b73cfaeadde85ef95092c303aef58a5fe2cafdd34401";
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const compareAscii = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const canonicalDigest = () => sha256(JSON.stringify(
  [...PRODUCTION_THUMBNAIL_DECISIONS.entries()].sort(([left], [right]) => compareAscii(left, right)),
));
const allowlistRows = parseCsv(await readFile("data/thumbnail-phase4b-legacy-allowlist.csv", "utf8"));
const exclusionRows = parseCsv(await readFile("data/thumbnail-phase4b-human-review-exclusions.csv", "utf8"));

test("Phase 4B registry contains exactly the 796 audited selections", () => {
  assert.equal(PHASE4B_LEGACY_THUMBNAIL_DECISIONS.size, 796);
  assert.equal(GENERATED_PHASE4B_LEGACY_RECORDS.length, 796);
  assert.equal(allowlistRows.length, 796);
  const modeCounts = [...PHASE4B_LEGACY_THUMBNAIL_DECISIONS.values()].reduce((counts, record) => {
    counts[record.mode] = (counts[record.mode] ?? 0) + 1;
    return counts;
  }, {});
  assert.deepEqual(modeCounts, {
    PACKAGE_RIGHT: 410,
    PACKAGE_CENTER: 141,
    SAMPLE: 129,
    PACKAGE_FULL: 116,
  });
  assert.deepEqual(
    {
      total: GENERATED_PHASE4B_LEGACY_STATS.total,
      SAMPLE: GENERATED_PHASE4B_LEGACY_STATS.SAMPLE,
      PACKAGE_RIGHT: GENERATED_PHASE4B_LEGACY_STATS.PACKAGE_RIGHT,
      PACKAGE_CENTER: GENERATED_PHASE4B_LEGACY_STATS.PACKAGE_CENTER,
      PACKAGE_FULL: GENERATED_PHASE4B_LEGACY_STATS.PACKAGE_FULL,
      SCENE_CROP: GENERATED_PHASE4B_LEGACY_STATS.SCENE_CROP,
    },
    { total: 796, SAMPLE: 129, PACKAGE_RIGHT: 410, PACKAGE_CENTER: 141, PACKAGE_FULL: 116, SCENE_CROP: 0 },
  );
});

test("canonical 79 decisions and their complete registry SHA remain unchanged", async () => {
  assert.equal(PRODUCTION_THUMBNAIL_DECISIONS.size, 79);
  assert.equal(canonicalDigest(), EXPECTED_CANONICAL_SHA256);
  assert.equal(GENERATED_PHASE4B_LEGACY_STATS.canonical_registry_sha256, EXPECTED_CANONICAL_SHA256);
  const expectedFiles = {
    "src/lib/thumbnail/canonical-decisions.ts": "380391029864875ce2b26585e9f36934b832820d11813a91d95b962764fab82a",
    "src/lib/thumbnail/generated-approved-decisions.ts": "bfe00b325c9b4c353370413cd2689f769c589c6beea78479152725e696d449c3",
    "data/thumbnail-gold-labels.csv": "31c5e2443a3c27f5105a62075b68cb7376a84bc8a6fd5d3f6beb6dbfc5196ddc",
    "data/thumbnail-human-approvals.csv": "473b65bd2c3d85917d90bb0a6249faeb961fe618d7e6e2d0c8a3fbc0c4f99bb1",
    "data/thumbnail-scene-crop-allowlist.csv": "9f60cce561a225da87053136e8ce875fbac5378bd41c3b668a36e31c3bc4edc0",
  };
  for (const [file, expected] of Object.entries(expectedFiles)) {
    assert.equal(sha256(await readFile(file)), expected, file);
  }
  for (const code of PHASE4B_LEGACY_THUMBNAIL_DECISIONS.keys()) {
    assert.equal(getProductionThumbnailDecision(code), null, code);
  }
});

test("all 125 human-review items remain excluded, including 110 non-renderable and 15 sample close-margin items", () => {
  assert.equal(exclusionRows.length, 125);
  const counts = exclusionRows.reduce((result, row) => {
    result[row.review_category] = (result[row.review_category] ?? 0) + 1;
    return result;
  }, {});
  assert.deepEqual(counts, { NON_RENDERABLE: 110, SAMPLE_CLOSE_MARGIN: 15 });
  for (const row of exclusionRows) {
    assert.equal(getPhase4BLegacyThumbnailDecision(row.code), null, row.code);
  }
});

test("Phase 4B records cannot claim SCENE_CROP or canonical human/gold approval", () => {
  for (const record of GENERATED_PHASE4B_LEGACY_RECORDS) {
    assert.notEqual(record.mode, "SCENE_CROP", record.code);
    assert.equal(Object.hasOwn(record, "approval_status"), false, record.code);
    assert.equal(Object.hasOwn(record, "approved_by"), false, record.code);
    assert.equal(Object.hasOwn(record, "approved_at"), false, record.code);
    const resolved = resolveThumbnailPresentation({
      code: record.code,
      legacy_runtime_override: null,
      legacy_card_url: "/card-thumbnails/stale.jpg",
    });
    assert.equal(resolved.resolution_kind, "LEGACY_COMPAT", record.code);
    assert.equal(resolved.source_kind, "PHASE4B_EXPLICIT_LEGACY", record.code);
    assert.equal(resolved.approval_status, "UNREVIEWED", record.code);
    assert.equal(resolved.crop_spec, null, record.code);
    assert.equal(resolved.canonical_decision, null, record.code);
  }
});

test("one resolution priority keeps canonical first and Phase 4B ahead of older legacy inputs", () => {
  assert.deepEqual(THUMBNAIL_PRESENTATION_PRIORITY, [
    "canonical_decision",
    "phase4b_explicit_legacy",
    "legacy_runtime_override",
    "legacy_card_url",
    "legacy_thumbnail_url",
    "placeholder",
  ]);
  const phase4B = resolveThumbnailPresentation({
    code: "125UMD01010",
    legacy_runtime_override: {
      path: "/card-thumbnails/stale-runtime.jpg",
      mode: "sample",
      source_id: "sample:1",
      output_hash: null,
    },
    legacy_card_url: "/card-thumbnails/stale-card.jpg",
    legacy_thumbnail_url: "https://pics.dmm.co.jp/stale-thumbnail.jpg",
  });
  assert.equal(phase4B.source_kind, "PHASE4B_EXPLICIT_LEGACY");
  assert.equal(phase4B.mode, "PACKAGE_RIGHT");
  assert.equal(phase4B.source_id, "dvd:right");
  assert.equal(phase4B.resolved_url, "/card-thumbnails/125UMD01010-auto-right.jpg");

  const canonical = resolveThumbnailPresentation({
    code: "1SBP00414",
    legacy_runtime_override: null,
    legacy_card_url: "/card-thumbnails/stale-card.jpg",
  });
  assert.equal(canonical.resolution_kind, "CANONICAL");
  assert.equal(canonical.mode, "SCENE_CROP");
});

test("audit modes keep their exact fit, source ID, null crop, and deterministic CSS package positioning", () => {
  const cases = [
    ["YMDS00301", "SAMPLE", "sample:1", "cover", "center", "AUDIT_OUTPUT"],
    ["125UMD01010", "PACKAGE_RIGHT", "dvd:right", "cover", "right", "AUDIT_OUTPUT"],
    ["125UMD01013", "PACKAGE_CENTER", "dvd:center", "cover", "center", "CSS_PACKAGE_POSITION"],
    ["172RECA00042AI", "PACKAGE_FULL", "dvd:full", "contain", "center", "AUDIT_OUTPUT"],
  ];
  for (const [code, mode, sourceId, fit, position, strategy] of cases) {
    const record = getPhase4BLegacyThumbnailDecision(code);
    assert.ok(record, code);
    assert.equal(record.mode, mode, code);
    assert.equal(record.source_id, sourceId, code);
    assert.equal(record.render_strategy, strategy, code);
    const resolution = resolveThumbnailPresentation({ code, legacy_runtime_override: null });
    const contract = buildThumbnailRenderContract(resolution);
    assert.equal(resolution.approval_status, "UNREVIEWED", code);
    assert.equal(resolution.crop_spec, null, code);
    assert.equal(contract.object_fit, fit, code);
    assert.equal(contract.object_position, position, code);
    assert.equal(contract.src, record.resolved_url, code);
  }
  assert.equal(GENERATED_PHASE4B_LEGACY_STATS.css_package_position, 150);
});

test("list, search, ranking, newest, related, detail, Recently Viewed, and JSON-LD share the same Phase 4B resolution", () => {
  for (const code of ["125UMD01010", "125UMD01013", "YMDS00301", "172RECA00042AI"]) {
    const input = {
      code,
      legacy_runtime_override: null,
      legacy_card_url: "/card-thumbnails/stale.jpg",
      legacy_thumbnail_url: "https://pics.dmm.co.jp/stale.jpg",
    };
    const surfaces = ["list", "search", "ranking", "newest", "related", "detail", "recently-viewed"]
      .map(() => resolveThumbnailPresentation(input));
    assert.equal(new Set(surfaces.map((resolution) => JSON.stringify(resolution))).size, 1, code);
    const contract = buildThumbnailRenderContract(surfaces[0]);
    const jsonLd = thumbnailStructuredDataImage(surfaces[0], "https://preview.example.test");
    assert.equal(jsonLd.image, contract.src?.startsWith("https://") ? contract.src : `https://preview.example.test${contract.src}`, code);
  }
});

test("Phase 4A focus products regress only through their existing canonical, review, or legacy paths", () => {
  const canonicalCases = {
    "1SBP00414": ["SCENE_CROP", "scene:pl"],
    "H_283PMFT00440": ["SAMPLE", "sample:2"],
    "H_283PMFT00443": ["SAMPLE", "sample:2"],
    "H_283PMFT00444": ["SAMPLE", "sample:3"],
    "1VRNC00094": ["PACKAGE_FULL", "dvd:full"],
    "BEBL00058": ["SAMPLE", "sample:4"],
  };
  for (const [code, [mode, sourceId]] of Object.entries(canonicalCases)) {
    assert.equal(getPhase4BLegacyThumbnailDecision(code), null, code);
    const result = resolveThumbnailPresentation({ code, legacy_runtime_override: null, legacy_card_url: "/card-thumbnails/stale.jpg" });
    assert.equal(result.resolution_kind, "CANONICAL", code);
    assert.equal(result.mode, mode, code);
    assert.equal(result.source_id, sourceId, code);
  }
  for (const code of ["H_283PMFT00441", "1STCVS00050"]) {
    assert.ok(exclusionRows.some((row) => row.code === code), code);
    assert.equal(getPhase4BLegacyThumbnailDecision(code), null, code);
  }
  for (const code of ["H_068HXGS01438", "AQUC000184"]) {
    assert.equal(getPhase4BLegacyThumbnailDecision(code), null, code);
    const result = resolveThumbnailPresentation({ code, legacy_runtime_override: null, legacy_card_url: "/card-thumbnails/stale.jpg" });
    assert.equal(result.source_kind, "LEGACY_DB_URL", code);
  }
});

test("runtime and client source never read the external Phase 4A audit CSV", async () => {
  for (const file of [
    "src/lib/thumbnail/phase4b-legacy-registry.ts",
    "src/lib/thumbnail/presentation.ts",
    "src/lib/thumbnail/generated-phase4b-legacy-registry.ts",
    "src/components/resolved-thumbnail.tsx",
  ]) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /phase4a-legacy-thumbnail-audit\.csv|phase4a-human-review\.csv/, file);
  }
});
