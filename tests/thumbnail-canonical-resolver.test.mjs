import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalizeProductCodeValue,
  normalizeFanzaItem,
} from "../src/lib/fanza/normalize.ts";
import {
  adaptHumanApprovalRecord,
  adaptLocalAssetRecord,
  adaptModeApprovalRecord,
} from "../src/lib/thumbnail/adapters.ts";
import {
  isTrustedThumbnailOutput,
  modeContract,
  validateThumbnailResolution,
} from "../src/lib/thumbnail/contract.ts";
import { nextSourceState } from "../src/lib/fanza/import-state.ts";
import { stageFanzaItems } from "../src/lib/fanza/pipeline.ts";
import {
  getProductionCanonicalThumbnailDecision,
  PRODUCTION_CANONICAL_THUMBNAIL_DECISIONS,
} from "../src/lib/thumbnail/canonical-decisions.ts";
import {
  isRenderableThumbnailResolution,
  THUMBNAIL_DECISION_PRIORITY,
  ThumbnailDecisionContractError,
  resolveCanonicalThumbnail,
} from "../src/lib/thumbnail/resolver.ts";
import { fixedThumbnailExpectations } from "./fixtures/thumbnail-canonical-cases.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const resolvedHumanDecision = (overrides = {}) => ({
  kind: "RESOLVED",
  code: "CHECK00001",
  mode: "PACKAGE_RIGHT",
  source_id: "dvd:right",
  source_kind: "PACKAGE",
  source_path_or_url: "/source.jpg",
  source_hash: HASH_A,
  output_path_or_url: "/card-thumbnails/output.jpg",
  output_hash: HASH_B,
  object_fit: "cover",
  crop_spec: null,
  approval_status: "HUMAN_APPROVED",
  render_status: "READY",
  approved_by: "USER_HANDOFF",
  approved_at: "2026-07-29",
  reason: "test decision",
  ...overrides,
});

const completeDatabaseFallback = (overrides = {}) => ({
  source_id: "dvd:right",
  source_kind: "PACKAGE",
  source_path_or_url: "/source.jpg",
  url: "/card-thumbnails/db-card.jpg",
  mode: "PACKAGE_RIGHT",
  object_fit: "cover",
  crop_spec: null,
  reason: "database card URL with a complete render contract",
  ...overrides,
});

test("normalizeFanzaItem applies exact FT62 and FT64 aliases to persisted keys", () => {
  const cases = [
    ["H_1784FT000062", "H_1784FTO00062", "H1784FTO00062"],
    ["H_1784FT000064", "H_1784FTO00064", "H1784FTO00064"],
  ];
  for (const [input, productCode, normalizedCode] of cases) {
    const item = normalizeFanzaItem({ product_id: input });
    assert.equal(item.productCode, productCode);
    assert.equal(item.normalizedProductCode, normalizedCode);
  }
  assert.equal(
    canonicalizeProductCodeValue("  h_1784ft000062  ").canonical,
    "H_1784FTO00062",
  );
  assert.equal(
    normalizeFanzaItem({ product_id: "H_1784FT000063" }).productCode,
    "H_1784FT000063",
  );
  const ordinary = normalizeFanzaItem({ product_id: "abc-001" });
  assert.equal(ordinary.productCode, "ABC-001");
  assert.equal(ordinary.normalizedProductCode, "ABC001");
});

test("FT and FTO forms produce one persisted key", () => {
  for (const suffix of ["62", "64"]) {
    const alias = normalizeFanzaItem({ product_id: `H_1784FT0000${suffix}` });
    const canonical = normalizeFanzaItem({ product_id: `H_1784FTO000${suffix}` });
    assert.equal(alias.productCode, canonical.productCode);
    assert.equal(alias.normalizedProductCode, canonical.normalizedProductCode);
  }
});

test("1NAMH500006 is rejected as a canonical storage key and resolution input", () => {
  const normalized = canonicalizeProductCodeValue("1NAMH500006");
  assert.equal(normalized.rejected, true);
  assert.equal(normalized.canonical, null);
  const item = normalizeFanzaItem({ product_id: "1NAMH500006" });
  assert.equal(item.productCode, null);
  assert.equal(item.normalizedProductCode, null);

  const result = resolveCanonicalThumbnail({
    code: "1NAMH500006",
    database_url: completeDatabaseFallback(),
  });
  assert.equal(result.kind, "INVALID_CODE");
  assert.equal(result.resolved_url, null);
  assert.equal(getProductionCanonicalThumbnailDecision("1NAMH500006"), null);
});

test("runtime validation rejects impossible mode, source kind, and source ID combinations", () => {
  assert.throws(
    () =>
      resolveCanonicalThumbnail({
        code: "CHECK00001",
        human_decision: resolvedHumanDecision({
          mode: "SAMPLE",
          source_kind: "PACKAGE",
          source_id: "dvd:right",
        }),
      }),
    ThumbnailDecisionContractError,
  );
});

test("SAMPLE requires scale-down and rejects forged cover or contain fits", () => {
  const valid = resolvedHumanDecision({
    code: "SAMPLEFIT0001",
    mode: "SAMPLE",
    source_kind: "SAMPLE",
    source_id: "sample:1",
    object_fit: "scale-down",
  });
  const result = resolveCanonicalThumbnail({
    code: "SAMPLEFIT0001",
    human_decision: valid,
  });
  assert.equal(result.kind, "RESOLVED");
  assert.equal(result.object_fit, "scale-down");
  assert.equal(result.crop_spec, null);

  for (const objectFit of ["cover", "contain"]) {
    assert.throws(
      () =>
        resolveCanonicalThumbnail({
          code: "SAMPLEFIT0001",
          human_decision: { ...valid, object_fit: objectFit },
        }),
      ThumbnailDecisionContractError,
      objectFit,
    );
  }
});

test("SOURCE_MISSING cannot be supplied as a normal canonical decision", () => {
  assert.throws(
    () =>
      resolveCanonicalThumbnail({
        code: "CHECK00001",
        human_decision: {
          ...resolvedHumanDecision(),
          kind: "SOURCE_MISSING",
          approval_status: null,
          render_status: null,
          source_id: null,
          source_path_or_url: null,
          source_hash: null,
          output_path_or_url: null,
          output_hash: null,
        },
      }),
    ThumbnailDecisionContractError,
  );
  const missing = resolveCanonicalThumbnail({ code: "MISSING0001" });
  assert.equal(missing.kind, "SOURCE_MISSING");
  assert.equal(missing.mode, null);
  assert.equal(missing.resolved_url, null);
});

test("HUMAN_APPROVED requires approver, date, source hash, and output hash", () => {
  for (const overrides of [
    { approved_by: null },
    { approved_at: null },
    { source_hash: null },
    { output_path_or_url: null },
    { output_hash: null },
  ]) {
    assert.throws(
      () =>
        resolveCanonicalThumbnail({
          code: "CHECK00001",
          human_decision: resolvedHumanDecision(overrides),
        }),
      ThumbnailDecisionContractError,
    );
  }
});

test("MODE_APPROVED can resolve an exact source but requires approver provenance", () => {
  const decision = adaptModeApprovalRecord({
    code: "MODEAPPROVED0001",
    mode: "full",
    state: "RESOLVED",
    source_id: "dvd:full",
    source_path_or_url: "https://pics.dmm.co.jp/mode-approved-source.jpg",
    source_hash: HASH_A,
    output_path_or_url: "https://pics.dmm.co.jp/mode-approved-source.jpg",
    output_hash: HASH_A,
    approved_by: "USER_HANDOFF",
    approved_at: "2026-07-31",
    reason: "mode and exact source are approved",
  });
  assert.equal(decision.kind, "RESOLVED");
  assert.equal(decision.approval_status, "MODE_APPROVED");
  assert.equal(decision.render_status, "READY");
  assert.throws(
    () =>
      adaptModeApprovalRecord({
        code: "MODEAPPROVED0002",
        mode: "full",
        state: "RESOLVED",
        source_id: "dvd:full",
        source_path_or_url: "https://pics.dmm.co.jp/mode-approved-source.jpg",
        source_hash: HASH_A,
        output_path_or_url: "https://pics.dmm.co.jp/mode-approved-source.jpg",
        output_hash: HASH_A,
        reason: "missing approver provenance",
      }),
    ThumbnailDecisionContractError,
  );
});

test("SCENE_FULL requires contain and crop_spec=null", () => {
  const valid = resolvedHumanDecision({
    code: "SCENE00001",
    mode: "SCENE_FULL",
    source_id: "scene:1",
    source_kind: "SCENE",
    object_fit: "contain",
  });
  const result = resolveCanonicalThumbnail({
    code: "SCENE00001",
    human_decision: valid,
  });
  assert.equal(result.kind, "RESOLVED");
  assert.equal(result.object_fit, "contain");
  assert.equal(result.crop_spec, null);

  for (const overrides of [
    { object_fit: "cover" },
    { crop_spec: { unit: "ratio", x: 0, y: 0, width: 1, height: 1 } },
  ]) {
    assert.throws(
      () =>
        resolveCanonicalThumbnail({
          code: "SCENE00001",
          human_decision: { ...valid, ...overrides },
        }),
      ThumbnailDecisionContractError,
    );
  }
});

test("SCENE_CROP requires a resolved human decision and crop_spec", () => {
  const crop = { unit: "ratio", x: 0.1, y: 0, width: 0.7, height: 1 };
  const valid = resolvedHumanDecision({
    code: "SCENE00002",
    mode: "SCENE_CROP",
    source_id: "scene:2",
    source_kind: "SCENE",
    object_fit: "scale-down",
    crop_spec: crop,
  });
  const result = resolveCanonicalThumbnail({
    code: "SCENE00002",
    human_decision: valid,
  });
  assert.equal(result.kind, "RESOLVED");
  assert.equal(result.object_fit, "scale-down");
  assert.deepEqual(result.crop_spec, crop);
  assert.throws(
    () =>
      resolveCanonicalThumbnail({
        code: "SCENE00002",
        human_decision: { ...valid, object_fit: "cover" },
      }),
    ThumbnailDecisionContractError,
  );
  assert.throws(
    () =>
      resolveCanonicalThumbnail({
        code: "SCENE00002",
        gold_label: {
          ...valid,
          approval_status: "GOLD_APPROVED",
          approved_by: null,
          approved_at: null,
        },
      }),
    ThumbnailDecisionContractError,
  );
  assert.throws(
    () =>
      adaptModeApprovalRecord({
        code: "SCENE00002",
        mode: "scene_crop",
        state: "RESOLVED",
        source_id: "scene:2",
        source_path_or_url: "/card-thumbnails/scene-crop.jpg",
        source_hash: HASH_A,
        output_path_or_url: "/card-thumbnails/scene-crop.jpg",
        output_hash: HASH_A,
        crop_spec: crop,
        approved_by: "USER_HANDOFF",
        approved_at: "2026-07-31",
        reason: "mode approval cannot authorize a scene crop",
      }),
    ThumbnailDecisionContractError,
  );
  assert.throws(
    () =>
      resolveCanonicalThumbnail({
        code: "SCENE00002",
        human_decision: { ...valid, crop_spec: null },
      }),
    ThumbnailDecisionContractError,
  );
});

test("fallback refuses incomplete mode/object-fit contracts", () => {
  assert.throws(
    () =>
      resolveCanonicalThumbnail({
        code: "FALLBACK0001",
        database_url: completeDatabaseFallback({ mode: undefined }),
      }),
    ThumbnailDecisionContractError,
  );
  assert.throws(
    () =>
      resolveCanonicalThumbnail({
        code: "FALLBACK0001",
        database_url: completeDatabaseFallback({ object_fit: undefined }),
      }),
    ThumbnailDecisionContractError,
  );
});

test("fallback accepts complete SCENE_FULL without a crop and rejects untrusted hosts", () => {
  const scene = resolveCanonicalThumbnail({
    code: "FALLBACK0002",
    database_url: completeDatabaseFallback({
      mode: "SCENE_FULL",
      source_id: "scene:1",
      source_kind: "SCENE",
      object_fit: "contain",
      crop_spec: null,
    }),
  });
  assert.equal(scene.kind, "RESOLVED");
  assert.equal(scene.mode, "SCENE_FULL");
  assert.equal(scene.crop_spec, null);

  assert.throws(
    () =>
      resolveCanonicalThumbnail({
        code: "FALLBACK0003",
        external_fallback: completeDatabaseFallback({
          source_path_or_url: "https://example.com/source.jpg",
          url: "https://example.com/output.jpg",
        }),
      }),
    ThumbnailDecisionContractError,
  );
});

test("pending canonical decisions block lower-priority fallbacks and are not renderable", () => {
  const pending = adaptHumanApprovalRecord({
    code: "PENDING0001",
    mode: "scene_full",
    state: "PENDING_SOURCE",
    approved_by: "USER_HANDOFF",
    approved_at: "2026-07-29",
    reason: "mode approved while source remains unknown",
  });
  const result = resolveCanonicalThumbnail({
    code: "PENDING0001",
    human_decision: pending,
    database_url: completeDatabaseFallback(),
  });
  assert.equal(result.kind, "PENDING_SOURCE");
  assert.equal(result.resolved_url, null);
  assert.equal(isRenderableThumbnailResolution(result), false);
});

test("only a complete RESOLVED contract is renderable", () => {
  const result = resolveCanonicalThumbnail({
    code: "RENDER0001",
    database_url: completeDatabaseFallback(),
  });
  assert.equal(result.kind, "RESOLVED");
  assert.equal(isRenderableThumbnailResolution(result), true);
  assert.equal(
    isRenderableThumbnailResolution(resolveCanonicalThumbnail({ code: "NONE00001" })),
    false,
  );
});

test("AQUGL00004 resolves the approved sample:12 output and never uses stale candidates", () => {
  const decision = getProductionCanonicalThumbnailDecision("AQUGL00004");
  assert.equal(decision?.kind, "RESOLVED");
  assert.equal(decision?.source_id, "sample:12");
  assert.equal(
    decision?.source_hash,
    "fdb6ab1bdbfb7005b46a626ca06e3a7af31452096b16b270d3b238e91bc68ca3",
  );
  assert.equal(
    decision?.source_path_or_url,
    "https://pics.dmm.co.jp/digital/video/aqugl00004/aqugl00004jp-12.jpg",
  );
  assert.equal(
    decision?.output_path_or_url,
    "/card-thumbnails/AQUGL00004-gold-sample-12.jpg",
  );
  assert.equal(decision?.output_hash, decision?.source_hash);
  assert.equal(decision?.approval_status, "HUMAN_APPROVED");
  assert.equal(decision?.render_status, "READY");
  assert.equal(decision?.approved_by, "USER_HANDOFF");
  assert.doesNotMatch(JSON.stringify(decision), /b7f305ea|85b6fe7a|auto-right/);
  const result = resolveCanonicalThumbnail({
    code: "AQUGL00004",
    database_url: completeDatabaseFallback(),
  });
  assert.equal(result.kind, "RESOLVED");
  assert.equal(result.approval_status, "HUMAN_APPROVED");
  assert.equal(result.render_status, "READY");
  assert.equal(
    result.resolved_url,
    "/card-thumbnails/AQUGL00004-gold-sample-12.jpg",
  );
  assert.equal(isRenderableThumbnailResolution(result), true);
});

test("1START00590 fixes the reviewed sample source separately from its output", () => {
  const decision = getProductionCanonicalThumbnailDecision("1START00590");
  assert.equal(decision?.kind, "RESOLVED");
  assert.equal(
    decision?.source_path_or_url,
    "https://pics.dmm.co.jp/digital/video/1start00590/1start00590jp-1.jpg",
  );
  assert.equal(
    decision?.output_path_or_url,
    "/card-thumbnails/1START00590-gold-sample-1.jpg",
  );
});

test("H_068MXDLP00335 fixes the full package source separately from its output", () => {
  const decision = getProductionCanonicalThumbnailDecision("H_068MXDLP00335");
  assert.equal(decision?.kind, "RESOLVED");
  assert.equal(
    decision?.source_path_or_url,
    "https://pics.dmm.co.jp/digital/video/h_068mxdlp00335/h_068mxdlp00335pl.jpg",
  );
  assert.equal(
    decision?.output_path_or_url,
    "/card-thumbnails/H_068MXDLP00335-gold-full.jpg",
  );
});

test("the eight fixed regressions resolve through production decisions", () => {
  assert.equal(PRODUCTION_CANONICAL_THUMBNAIL_DECISIONS.size, 8);
  for (const expected of fixedThumbnailExpectations) {
    const result = resolveCanonicalThumbnail({ code: expected.inputCode });
    assert.equal(result.decision_source, "production_canonical");
    assert.equal(result.canonical_code, expected.canonicalCode);
    assert.equal(result.kind, expected.kind);
    assert.equal(result.mode, expected.mode);
    assert.equal(result.source_id, expected.sourceId);
    assert.equal(result.approval_status, expected.approvalStatus);
    assert.equal(result.render_status, expected.renderStatus);
  }
});

test("Phase 3A fixes exact source and output provenance for all four works", () => {
  const expected = [
    [
      "AQUGL00004",
      "SAMPLE",
      "sample:12",
      "https://pics.dmm.co.jp/digital/video/aqugl00004/aqugl00004jp-12.jpg",
      "/card-thumbnails/AQUGL00004-gold-sample-12.jpg",
      "fdb6ab1bdbfb7005b46a626ca06e3a7af31452096b16b270d3b238e91bc68ca3",
      "scale-down",
    ],
    [
      "1SBP00423",
      "SCENE_FULL",
      "scene:pl",
      "https://pics.dmm.co.jp/digital/video/1sbp00423/1sbp00423pl.jpg",
      "https://pics.dmm.co.jp/digital/video/1sbp00423/1sbp00423pl.jpg",
      "5467e64d88abe1a9abe13c22c85b53e0871891d89034e77f19abf5ba0080d4ba",
      "contain",
    ],
    [
      "H_1784FTO00062",
      "PACKAGE_FULL",
      "dvd:full",
      "https://pics.dmm.co.jp/digital/video/h_1784fto00062/h_1784fto00062pl.jpg",
      "https://pics.dmm.co.jp/digital/video/h_1784fto00062/h_1784fto00062pl.jpg",
      "e5cf3c1f156f512a2b13d00c0c517c02214338aa143cda9a18aa75319995a8e3",
      "contain",
    ],
    [
      "H_1784FTO00064",
      "PACKAGE_FULL",
      "dvd:full",
      "https://pics.dmm.co.jp/digital/video/h_1784fto00064/h_1784fto00064pl.jpg",
      "https://pics.dmm.co.jp/digital/video/h_1784fto00064/h_1784fto00064pl.jpg",
      "44972d0cad9c01823d9a0a66c470782c9b5185bda449228013e87ca2a63ed59b",
      "contain",
    ],
  ];
  for (const [
    code,
    mode,
    sourceId,
    source,
    output,
    hash,
    objectFit,
  ] of expected) {
    const decision = getProductionCanonicalThumbnailDecision(code);
    assert.equal(decision?.kind, "RESOLVED", code);
    assert.equal(decision?.mode, mode, code);
    assert.equal(decision?.source_id, sourceId, code);
    assert.equal(decision?.source_path_or_url, source, code);
    assert.equal(decision?.output_path_or_url, output, code);
    assert.equal(decision?.source_hash, hash, code);
    assert.equal(decision?.output_hash, hash, code);
    assert.equal(decision?.object_fit, objectFit, code);
    assert.equal(decision?.crop_spec, null, code);
  }
});

test("Phase 3A records the current FTO PACKAGE_FULL approval provenance", () => {
  const expected = [
    [
      "H_1784FTO00062",
      "2026-07-31 user approval supersedes the 2026-07-29 PACKAGE_RIGHT approval: PACKAGE_FULL is required because RIGHT omits the title, multi-person composition, and left-side work information",
    ],
    [
      "H_1784FTO00064",
      "2026-07-31 user approval supersedes the 2026-07-29 PACKAGE_RIGHT approval: PACKAGE_FULL is required because RIGHT omits the left-side description and cast composition",
    ],
  ];

  for (const [code, reason] of expected) {
    const decision = getProductionCanonicalThumbnailDecision(code);
    assert.equal(decision?.kind, "RESOLVED", code);
    assert.equal(decision?.mode, "PACKAGE_FULL", code);
    assert.equal(decision?.source_id, "dvd:full", code);
    assert.equal(decision?.approval_status, "MODE_APPROVED", code);
    assert.equal(decision?.render_status, "READY", code);
    assert.equal(decision?.approved_by, "USER_HANDOFF", code);
    assert.equal(decision?.approved_at, "2026-07-31", code);
    assert.equal(decision?.reason, reason, code);
  }
});

test("production resolved decisions override stale human RIGHT decisions", () => {
  const cases = [
    ["1SBP00423", "SCENE_FULL", "scene:pl"],
    ["H_1784FTO00062", "PACKAGE_FULL", "dvd:full"],
    ["H_1784FTO00064", "PACKAGE_FULL", "dvd:full"],
  ];
  for (const [code, mode, sourceId] of cases) {
    const staleRight = resolvedHumanDecision({ code });
    const result = resolveCanonicalThumbnail({
      code,
      human_decision: staleRight,
      database_url: completeDatabaseFallback(),
    });
    assert.equal(result.kind, "RESOLVED");
    assert.equal(result.decision_source, "production_canonical");
    assert.equal(result.mode, mode);
    assert.equal(result.source_id, sourceId);
    assert.equal(result.approval_status, "MODE_APPROVED");
    assert.equal(result.render_status, "READY");
  }
});

test("one priority definition includes production, human, gold, local, DB, external", () => {
  assert.deepEqual(THUMBNAIL_DECISION_PRIORITY, [
    "production_canonical",
    "human_decision",
    "gold_label",
    "local_generated_asset",
    "database_url",
    "external_fallback",
  ]);
});

test("approval status and render status remain independent for approved ready work", () => {
  const aq = getProductionCanonicalThumbnailDecision("AQUGL00004");
  assert.equal(aq?.approval_status, "HUMAN_APPROVED");
  assert.equal(aq?.render_status, "READY");
  assert.equal(aq?.source_id, "sample:12");
  assert.equal(aq?.approved_by, "USER_HANDOFF");
  assert.equal(
    aq?.output_path_or_url,
    "/card-thumbnails/AQUGL00004-gold-sample-12.jpg",
  );
  assert.equal(aq?.output_hash, aq?.source_hash);

  const scene = getProductionCanonicalThumbnailDecision("1SBP00423");
  assert.equal(scene?.approval_status, "MODE_APPROVED");
  assert.equal(scene?.render_status, "READY");
  assert.equal(scene?.mode, "SCENE_FULL");
  assert.equal(scene?.source_id, "scene:pl");
  assert.equal(
    scene?.source_hash,
    "5467e64d88abe1a9abe13c22c85b53e0871891d89034e77f19abf5ba0080d4ba",
  );
});

test("full resolution validation makes forged READY values non-renderable", () => {
  const valid = resolveCanonicalThumbnail({
    code: "RENDERFULL0001",
    human_decision: resolvedHumanDecision({ code: "RENDERFULL0001" }),
  });
  assert.equal(isRenderableThumbnailResolution(valid), true);
  for (const forged of [
    { ...valid, source_path_or_url: "" },
    { ...valid, reason: "" },
    { ...valid, source_hash: "bad" },
    { ...valid, mode: "SAMPLE" },
    { ...valid, approval_status: "UNREVIEWED" },
    { ...valid, render_status: "PENDING_OUTPUT" },
    { ...valid, decision_source: "gold_label" },
  ]) {
    assert.equal(isRenderableThumbnailResolution(forged), false);
    assert.throws(
      () => validateThumbnailResolution(forged),
      ThumbnailDecisionContractError,
    );
  }
});

test("trusted thumbnail URLs reject credentials, nonstandard ports, and deceptive hosts", () => {
  assert.equal(isTrustedThumbnailOutput("/card-thumbnails/example.jpg"), true);
  assert.equal(isTrustedThumbnailOutput("https://pics.dmm.co.jp/example.jpg"), true);
  assert.equal(isTrustedThumbnailOutput("https://pics.dmm.co.jp:443/example.jpg"), true);
  for (const candidate of [
    "https://user@pics.dmm.co.jp/example.jpg",
    "https://user:pass@pics.dmm.co.jp/example.jpg",
    "https://pics.dmm.co.jp:8443/example.jpg",
    "https://pics.dmm.co.jp.evil.example/example.jpg",
    "http://pics.dmm.co.jp/example.jpg",
    "javascript:alert(1)",
    "data:image/jpeg;base64,AAAA",
    "/card-thumbnails/../secret.jpg",
    "/card-thumbnails/%2e%2e/secret.jpg",
    "/card-thumbnails/%252e%252e/secret.jpg",
    "/card-thumbnails/%5csecret.jpg",
    "/card-thumbnails/%255csecret.jpg",
    "/card-thumbnails/example.jpg?redirect=1",
    "https://pics.dmm.co.jp/example.jpg?redirect=1",
  ]) {
    assert.equal(isTrustedThumbnailOutput(candidate), false, candidate);
  }
});

test("mode contracts are frozen and cannot be mutated by callers", () => {
  const sample = modeContract("SAMPLE");
  assert.equal(Object.isFrozen(sample), true);
  assert.throws(() => {
    sample.object_fit = "contain";
  }, TypeError);
  assert.equal(modeContract("SAMPLE").object_fit, "scale-down");
  assert.equal(modeContract("SAMPLE").source_kind, "SAMPLE");
});

test("the local asset adapter is a validated production adapter", () => {
  const local = adaptLocalAssetRecord({
    code: "LOCAL00001",
    mode: "right",
    state: "RESOLVED",
    source_id: "dvd:right",
    source_path_or_url: "/source.jpg",
    source_hash: HASH_A,
    output_path_or_url: "/card-thumbnails/local.jpg",
    output_hash: HASH_B,
    reason: "validated local asset",
  });
  assert.equal(local.approval_status, "LOCAL_APPROVED");
  assert.equal(local.render_status, "READY");
  const result = resolveCanonicalThumbnail({
    code: "LOCAL00001",
    local_generated_asset: local,
  });
  assert.equal(result.kind, "RESOLVED");
  assert.equal(result.decision_source, "local_generated_asset");
  assert.equal(isRenderableThumbnailResolution(result), true);
});

test("1NAMH500006 remains an isolated staging record without stopping its batch", async () => {
  const lookup = {
    async byExternalIds(ids) {
      return new Map(ids.map((id) => [id, []]));
    },
    async byNormalizedCodes(codes) {
      return new Map(codes.map((code) => [code, []]));
    },
  };
  const rejected = {
    product_id: "1NAMH500006",
    content_id: "1namh500006",
    title: "audit-only code",
    iteminfo: { actress: [{ name: "review" }] },
    URL: "https://www.dmm.co.jp/example",
    imageURL: { large: "https://pics.dmm.co.jp/example.jpg" },
  };
  const ordinary = {
    product_id: "VALID00001",
    content_id: "valid00001",
    title: "ordinary work",
    iteminfo: { actress: [{ name: "review" }] },
    URL: "https://www.dmm.co.jp/example",
    imageURL: { large: "https://pics.dmm.co.jp/example.jpg" },
  };
  const result = await stageFanzaItems([rejected, ordinary], lookup);
  assert.equal(result.errors.length, 0);
  assert.equal(result.products.length, 2);
  const isolated = result.products.find(
    (product) => product.normalized.originalProductCode === "1NAMH500006",
  );
  assert.equal(isolated?.normalized.productCode, null);
  assert.equal(isolated?.normalized.normalizedProductCode, null);
  assert.equal(isolated?.normalized.productCodeRejectionCode, "REJECTED_AUDIT_CODE");
  assert.equal(
    isolated?.normalized.productCodeRejectionReason,
    "audit-only product code is not a runtime identity",
  );
  assert.equal(isolated?.previewStatus, "needs_review");
  assert.equal(isolated?.reviewReasons.includes("REJECTED_AUDIT_CODE"), true);
  assert.equal(isolated?.duplicateVideoId, null);
  assert.equal(nextSourceState(isolated).previewStatus, "needs_review");
  assert.equal(
    result.products.find((product) => product.normalized.productCode === "VALID00001")
      ?.previewStatus,
    "new",
  );
  assert.equal(resolveCanonicalThumbnail({ code: "1NAMH500006" }).kind, "INVALID_CODE");
});
