import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildThumbnailRenderContract,
  resolveThumbnailPresentation,
  resolvedThumbnailUrl,
  THUMBNAIL_PRESENTATION_PRIORITY,
  validateLegacyCompatibilityResolution,
} from "../src/lib/thumbnail/presentation.ts";
import { ThumbnailDecisionContractError } from "../src/lib/thumbnail/contract.ts";
import { getLegacyRuntimeThumbnailOverride } from "../src/lib/fanza/media.ts";

const HASH = "a".repeat(64);
const legacyRight = {
  path: "/card-thumbnails/LEGACY00001-misleading-center-name.jpg",
  mode: "right",
  source_id: "dvd:right",
  output_hash: HASH,
};

const resolveAcrossSurfaces = (input) => ({
  list: resolveThumbnailPresentation(input),
  detail: resolveThumbnailPresentation(input),
  related: resolveThumbnailPresentation(input),
  recentlyViewed: resolveThumbnailPresentation(input),
  structuredData: resolveThumbnailPresentation(input),
});

test("one presentation priority separates canonical decisions from legacy compatibility", () => {
  assert.deepEqual(THUMBNAIL_PRESENTATION_PRIORITY, [
    "canonical_decision",
    "phase4b_explicit_legacy",
    "legacy_runtime_override",
    "legacy_card_url",
    "legacy_thumbnail_url",
    "placeholder",
  ]);

  const canonical = resolveThumbnailPresentation({
    code: "5561SGKT00002",
    legacy_runtime_override: legacyRight,
    legacy_card_url: "/card-thumbnails/stale.jpg",
  });
  assert.equal(canonical.resolution_kind, "CANONICAL");
  assert.equal(canonical.mode, "PACKAGE_RIGHT");
  assert.equal(canonical.source_id, "dvd:right");
  assert.equal(
    canonical.resolved_url,
    "/card-thumbnails/5561SGKT00002-auto-right.jpg",
  );
});

test("the four Phase 3A decisions render canonically and block every legacy URL", () => {
  const cases = [
    [
      "AQUGL00004",
      "SAMPLE",
      "sample:12",
      "/card-thumbnails/AQUGL00004-gold-sample-12.jpg",
    ],
    [
      "1SBP00423",
      "SCENE_FULL",
      "scene:pl",
      "https://pics.dmm.co.jp/digital/video/1sbp00423/1sbp00423pl.jpg",
    ],
    [
      "H_1784FT000062",
      "PACKAGE_FULL",
      "dvd:full",
      "https://pics.dmm.co.jp/digital/video/h_1784fto00062/h_1784fto00062pl.jpg",
    ],
    [
      "H_1784FT000064",
      "PACKAGE_FULL",
      "dvd:full",
      "https://pics.dmm.co.jp/digital/video/h_1784fto00064/h_1784fto00064pl.jpg",
    ],
  ];
  for (const [code, mode, sourceId, output] of cases) {
    const result = resolveThumbnailPresentation({
      code,
      legacy_runtime_override: legacyRight,
      legacy_card_url: "/card-thumbnails/stale.jpg",
      legacy_thumbnail_url: "https://pics.dmm.co.jp/stale.jpg",
    });
    assert.equal(result.resolution_kind, "CANONICAL", code);
    assert.equal(result.render_status, "READY", code);
    assert.equal(result.mode, mode, code);
    assert.equal(result.source_id, sourceId, code);
    assert.equal(buildThumbnailRenderContract(result).src, output, code);
  }
});

test("an explicit canonical SOURCE_MISSING outcome blocks legacy compatibility", () => {
  const result = resolveThumbnailPresentation({
    code: "MISSING0002",
    canonical_lookup_outcome: {
      kind: "SOURCE_MISSING",
      reason: "Canonical registry explicitly records a missing source",
    },
    legacy_runtime_override: legacyRight,
    legacy_card_url: "/card-thumbnails/stale.jpg",
  });
  assert.equal(result.resolution_kind, "NON_RENDERABLE");
  assert.equal(result.kind, "SOURCE_MISSING");
  assert.equal(result.reason, "Canonical registry explicitly records a missing source");
  assert.equal(buildThumbnailRenderContract(result).src, null);
});

test("invalid audit-only code cannot render through legacy compatibility", () => {
  const result = resolveThumbnailPresentation({
    code: "1NAMH500006",
    legacy_runtime_override: legacyRight,
    legacy_card_url: "/card-thumbnails/stale.jpg",
  });
  assert.equal(result.resolution_kind, "NON_RENDERABLE");
  assert.equal(result.kind, "INVALID_CODE");
  assert.equal(buildThumbnailRenderContract(result).src, null);
});

test("explicit runtime overrides retain informational mode but render contain without crop", () => {
  const result = resolveThumbnailPresentation({
    code: "LEGACY00001",
    legacy_runtime_override: legacyRight,
  });
  assert.equal(result.resolution_kind, "LEGACY_COMPAT");
  assert.equal(result.mode, "PACKAGE_RIGHT");
  assert.equal(result.source_id, "dvd:right");
  assert.match(result.resolved_url, /misleading-center-name/);
  assert.equal(result.source_kind, "LEGACY_RUNTIME_OVERRIDE");
  assert.equal(result.object_fit, "contain");
  assert.equal(result.crop_spec, null);
  assert.equal(result.approval_status, "UNREVIEWED");
  assert.equal(result.render_status, "READY");
});

test("the legacy runtime adapter preserves explicit mode and source ID without inferring from filenames", () => {
  const override = getLegacyRuntimeThumbnailOverride("1FCDSS00115");
  assert.ok(override);
  assert.equal(override.mode, "right");
  assert.equal(override.source_id, "dvd:right");
  assert.equal(
    override.path,
    "/card-thumbnails/1FCDSS00115-auto-right.jpg",
  );
  assert.equal(getLegacyRuntimeThumbnailOverride("1NAMH500006"), null);
});

test("two ordinary URL-only works use unclassified legacy compatibility", () => {
  const cases = [
    {
      code: "LEGACYCARD0001",
      legacy_card_url: "/card-thumbnails/legacy-card.jpg",
      expected: "/card-thumbnails/legacy-card.jpg",
      sourceId: "videos.card_thumbnail_url",
    },
    {
      code: "LEGACYTHUMB0001",
      legacy_card_url: null,
      legacy_thumbnail_url:
        "https://pics.dmm.co.jp/digital/video/13dsvr01998/13dsvr01998jp-1.jpg",
      expected:
        "https://pics.dmm.co.jp/digital/video/13dsvr01998/13dsvr01998jp-1.jpg",
      sourceId: "videos.thumbnail_url",
    },
  ];
  for (const fixture of cases) {
    const result = resolveThumbnailPresentation({
      ...fixture,
      legacy_runtime_override: null,
    });
    assert.equal(result.resolution_kind, "LEGACY_COMPAT", fixture.code);
    assert.equal(result.mode, null, fixture.code);
    assert.equal(result.source_id, fixture.sourceId, fixture.code);
    assert.equal(result.resolved_url, fixture.expected, fixture.code);
    assert.equal(result.object_fit, "contain", fixture.code);
    assert.equal(result.crop_spec, null, fixture.code);
  }
});

test("legacy compatibility has an independent validator and cannot claim canonical approval", () => {
  const valid = resolveThumbnailPresentation({
    code: "LEGACY00004",
    legacy_runtime_override: null,
    legacy_card_url: "/card-thumbnails/legacy.jpg",
  });
  assert.equal(validateLegacyCompatibilityResolution(valid), valid);
  for (const forged of [
    { ...valid, resolution_kind: "CANONICAL" },
    { ...valid, approval_status: "HUMAN_APPROVED" },
    { ...valid, object_fit: "cover" },
    {
      ...valid,
      crop_spec: { unit: "ratio", x: 0, y: 0, width: 1, height: 1 },
    },
  ]) {
    assert.throws(
      () => validateLegacyCompatibilityResolution(forged),
      ThumbnailDecisionContractError,
    );
  }
});

test("render contracts expose audit metadata without hashes or filesystem source paths", () => {
  const result = resolveThumbnailPresentation({
    code: "LEGACY00005",
    legacy_runtime_override: null,
    legacy_card_url: "/card-thumbnails/legacy.jpg",
  });
  const contract = buildThumbnailRenderContract(result);
  assert.deepEqual(contract.attributes, {
    code: "LEGACY00005",
    resolution_kind: "LEGACY_COMPAT",
    mode: "LEGACY_UNCLASSIFIED",
    source_id: "videos.card_thumbnail_url",
    approval_status: "UNREVIEWED",
    render_status: "READY",
  });
  assert.equal("source_hash" in contract.attributes, false);
  assert.equal("output_hash" in contract.attributes, false);
  assert.equal("source_path_or_url" in contract.attributes, false);
});

test("all five public surfaces receive the same fixed canonical result", () => {
  const cases = [
    ["1START00590", "SAMPLE", "sample:1", "READY"],
    ["5561SGKT00002", "PACKAGE_RIGHT", "dvd:right", "READY"],
    ["AQUGL00004", "SAMPLE", "sample:12", "READY"],
    ["1NAMHS00006", "PACKAGE_RIGHT", "dvd:right", "READY"],
    ["H_068MXDLP00335", "PACKAGE_FULL", "dvd:full", "READY"],
    ["1SBP00423", "SCENE_FULL", "scene:pl", "READY"],
    ["H_1784FT000062", "PACKAGE_FULL", "dvd:full", "READY"],
    ["H_1784FT000064", "PACKAGE_FULL", "dvd:full", "READY"],
  ];
  for (const [code, mode, sourceId, renderStatus] of cases) {
    const surfaces = resolveAcrossSurfaces({
      code,
      legacy_runtime_override: null,
      legacy_card_url: "/card-thumbnails/stale.jpg",
    });
    const serialized = Object.values(surfaces).map((value) =>
      JSON.stringify(value)
    );
    assert.equal(new Set(serialized).size, 1, code);
    const result = surfaces.list;
    assert.equal(result.resolution_kind, "CANONICAL", code);
    assert.equal(result.mode, mode, code);
    assert.equal(result.source_id, sourceId, code);
    assert.equal(result.render_status, renderStatus, code);
    if (code === "1SBP00423") {
      assert.equal(result.object_fit, "contain");
      assert.equal(result.crop_spec, null);
    }
    assert.ok(resolvedThumbnailUrl(result), code);
  }
});

test("FT and FTO spellings share one ready canonical decision", () => {
  for (const suffix of ["62", "64"]) {
    const alias = resolveThumbnailPresentation({
      code: `H_1784FT0000${suffix}`,
      legacy_runtime_override: null,
      legacy_card_url: "/card-thumbnails/stale.jpg",
    });
    const canonical = resolveThumbnailPresentation({
      code: `H_1784FTO000${suffix}`,
      legacy_runtime_override: null,
      legacy_card_url: "/card-thumbnails/stale.jpg",
    });
    assert.equal(alias.canonical_code, canonical.canonical_code);
    assert.equal(alias.resolution_kind, "CANONICAL");
    assert.equal(alias.kind, "RESOLVED");
    assert.equal(alias.mode, "PACKAGE_FULL");
    assert.equal(alias.source_id, "dvd:full");
    assert.equal(alias.approval_status, "MODE_APPROVED");
    assert.equal(alias.render_status, "READY");
    assert.equal(buildThumbnailRenderContract(alias).src, alias.resolved_url);
  }
});

test("legacy URL hardening fails closed to a placeholder before image rendering", () => {
  for (const value of [
    "/card-thumbnails/%252e%252e/secret.jpg",
    "/card-thumbnails/%5csecret.jpg",
    "/card-thumbnails/%255csecret.jpg",
    "https://user@pics.dmm.co.jp/image.jpg",
    "https://pics.dmm.co.jp:8443/image.jpg",
    "http://pics.dmm.co.jp/image.jpg",
    "https://pics.dmm.co.jp.evil.example/image.jpg",
    "https://pics.dmm.co.jp/image.jpg?query=1",
  ]) {
    const result = resolveThumbnailPresentation({
      code: "LEGACY00006",
      legacy_runtime_override: null,
      legacy_card_url: value,
    });
    assert.equal(result.resolution_kind, "NON_RENDERABLE", value);
    assert.equal(result.kind, "SOURCE_MISSING", value);
    assert.equal(buildThumbnailRenderContract(result).src, null, value);
  }
});

test("public display surfaces use the shared resolver and Recently Viewed has no hardcoded URL map", () => {
  const card = readFileSync(
    new URL("../src/components/public-work-card.tsx", import.meta.url),
    "utf8",
  );
  const detail = readFileSync(
    new URL("../src/app/work/[product_code]/page.tsx", import.meta.url),
    "utf8",
  );
  const recent = readFileSync(
    new URL("../src/components/recently-viewed.tsx", import.meta.url),
    "utf8",
  );
  const query = readFileSync(
    new URL("../src/lib/queries/public-works.ts", import.meta.url),
    "utf8",
  );
  const image = readFileSync(
    new URL("../src/components/resolved-thumbnail.tsx", import.meta.url),
    "utf8",
  );
  assert.match(card, /resolveThumbnailPresentation/);
  assert.match(card, /ResolvedThumbnail/);
  assert.match(detail, /resolveThumbnailPresentation/);
  assert.match(detail, /resolvedThumbnailUrl/);
  assert.match(detail, /ResolvedThumbnail/);
  assert.match(recent, /resolveThumbnailPresentation/);
  assert.doesNotMatch(recent, /CARD_THUMBNAIL_OVERRIDES/);
  assert.doesNotMatch(recent, /-rotated\|-full/);
  assert.doesNotMatch(query, /resolvedCardThumbnailUrl/);
  assert.match(image, /data-thumbnail-approval-status/);
  assert.match(image, /data-thumbnail-render-status/);
  assert.doesNotMatch(image, /source_hash|output_hash|source_path_or_url/);
});
