import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveEffectiveThumbnailRender,
  THUMBNAIL_UPSCALE_EPSILON,
} from "../src/lib/thumbnail/render-policy.ts";
import {
  PRODUCTION_THUMBNAIL_DECISIONS,
} from "../src/lib/thumbnail/production-registry.ts";
import {
  buildThumbnailRenderContract,
  resolveThumbnailPresentation,
} from "../src/lib/thumbnail/presentation.ts";

const policy = (requested_fit, requested_position, dimensions) =>
  resolveEffectiveThumbnailRender({
    requested_fit,
    requested_position,
    upscale_policy: "DENY",
    fallback_when_upscale_required: "scale-down",
    dimensions,
  });

test("unknown image dimensions use the centered no-upscale fallback", () => {
  const result = policy("cover", "right", null);
  assert.equal(result.image_dimensions_ready, false);
  assert.equal(result.effective_fit, "scale-down");
  assert.equal(result.effective_position, "center");
  assert.equal(result.fallback_applied, true);
  assert.equal(result.requested_scale, null);
});

test("PACKAGE_RIGHT and PACKAGE_CENTER keep crop alignment only when cover needs no upscale", () => {
  const safeRight = policy("cover", "right", {
    natural_width: 1000,
    natural_height: 1000,
    container_width: 500,
    container_height: 700,
  });
  assert.equal(safeRight.effective_fit, "cover");
  assert.equal(safeRight.effective_position, "right");
  assert.equal(safeRight.effective_scale, 0.7);
  assert.equal(safeRight.upscale_required, false);

  const safeCenter = policy("cover", "center", {
    natural_width: 1000,
    natural_height: 1000,
    container_width: 500,
    container_height: 700,
  });
  assert.equal(safeCenter.effective_fit, "cover");
  assert.equal(safeCenter.effective_position, "center");
});

test("cover that requires enlargement falls back without changing the URL decision", () => {
  const result = policy("cover", "right", {
    natural_width: 315,
    natural_height: 450,
    container_width: 560,
    container_height: 747,
  });
  assert.equal(result.upscale_required, true);
  assert.equal(result.fallback_applied, true);
  assert.equal(result.effective_fit, "scale-down");
  assert.equal(result.effective_position, "center");
  assert.equal(result.effective_scale, 1);
});

test("contain preserves its intent when safe and falls back when it would enlarge", () => {
  const safe = policy("contain", "center", {
    natural_width: 800,
    natural_height: 1200,
    container_width: 400,
    container_height: 600,
  });
  assert.equal(safe.effective_fit, "contain");
  assert.equal(safe.effective_scale, 0.5);

  const unsafe = policy("contain", "center", {
    natural_width: 315,
    natural_height: 450,
    container_width: 560,
    container_height: 747,
  });
  assert.equal(unsafe.effective_fit, "scale-down");
  assert.equal(unsafe.effective_scale, 1);
  assert.equal(unsafe.upscale_required, true);
});

test("scale-down never exceeds one and the tolerance boundary is deterministic", () => {
  const scaled = policy("scale-down", "center", {
    natural_width: 100,
    natural_height: 100,
    container_width: 500,
    container_height: 500,
  });
  assert.equal(scaled.effective_fit, "scale-down");
  assert.equal(scaled.effective_scale, 1);
  assert.equal(scaled.upscale_required, false);

  const withinTolerance = policy("cover", "right", {
    natural_width: 1000,
    natural_height: 1000,
    container_width: 1000 * (1 + THUMBNAIL_UPSCALE_EPSILON),
    container_height: 1000,
  });
  assert.equal(withinTolerance.effective_fit, "cover");
  const overTolerance = policy("cover", "right", {
    natural_width: 1000,
    natural_height: 1000,
    container_width: 1000 * (1 + THUMBNAIL_UPSCALE_EPSILON + 0.000001),
    container_height: 1000,
  });
  assert.equal(overTolerance.effective_fit, "scale-down");
});

test("all 29 SCENE_CROP decisions retain provenance and use one no-upscale contract", () => {
  const scenes = [...PRODUCTION_THUMBNAIL_DECISIONS.values()].filter(
    (decision) => decision.mode === "SCENE_CROP",
  );
  assert.equal(scenes.length, 29);
  assert.ok(scenes.some((decision) => decision.code === "1SBP00416"));
  for (const decision of scenes) {
    const resolution = resolveThumbnailPresentation({
      code: decision.code,
      legacy_runtime_override: null,
    });
    const contract = buildThumbnailRenderContract(resolution);
    assert.equal(contract.src, decision.output_path_or_url, decision.code);
    assert.equal(contract.object_fit, "scale-down", decision.code);
    assert.equal(contract.object_position, "center", decision.code);
    assert.equal(contract.crop_intent, "PREPROCESSED_CROP", decision.code);
    assert.equal(contract.upscale_policy, "DENY", decision.code);
    assert.equal(contract.fallback_when_upscale_required, "scale-down", decision.code);
    assert.deepEqual(contract.crop_spec, decision.crop_spec, decision.code);
    const card = policy("scale-down", "center", {
      natural_width: 315,
      natural_height: 450,
      container_width: 166,
      container_height: 237,
    });
    const detail = policy("scale-down", "center", {
      natural_width: 315,
      natural_height: 450,
      container_width: 560,
      container_height: 747,
    });
    assert.ok((card.effective_scale ?? Infinity) <= 1, decision.code);
    assert.ok((detail.effective_scale ?? Infinity) <= 1, decision.code);
  }
});

test("legacy URL-only compatibility is unclassified, centered, and scale-down", () => {
  const resolution = resolveThumbnailPresentation({
    code: "LEGACYNOUPSCALE0001",
    legacy_runtime_override: null,
    legacy_card_url: "/card-thumbnails/legacy.jpg",
  });
  const contract = buildThumbnailRenderContract(resolution);
  assert.equal(contract.attributes.mode, "LEGACY_UNCLASSIFIED");
  assert.equal(contract.object_fit, "scale-down");
  assert.equal(contract.object_position, "center");
  assert.equal(contract.crop_intent, "NONE");
  assert.equal(contract.upscale_policy, "DENY");
});
