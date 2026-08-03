import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

register(
  new URL("./support/thumbnail-tsx-loader.mjs", import.meta.url),
  import.meta.url,
);

const { ResolvedThumbnail } = await import(
  "../src/components/resolved-thumbnail.tsx"
);
const { adaptHumanApprovalRecord } = await import(
  "../src/lib/thumbnail/adapters.ts"
);
const { resolveThumbnailPresentation } = await import(
  "../src/lib/thumbnail/presentation.ts"
);

const HASH = "a".repeat(64);

function resolve(code, legacyCardUrl = "/card-thumbnails/stale.jpg") {
  return resolveThumbnailPresentation({
    code,
    legacy_runtime_override: null,
    legacy_card_url: legacyCardUrl,
    legacy_thumbnail_url: "https://pics.dmm.co.jp/stale.jpg",
  });
}

function render(resolution) {
  return renderToStaticMarkup(
    createElement(ResolvedThumbnail, {
      resolution,
      alt: "thumbnail test",
      sizes: "200px",
      className: "relative overflow-hidden",
    }),
  );
}

function assertPlaceholder(html, staleUrl = "/card-thumbnails/stale.jpg") {
  assert.doesNotMatch(html, /<img\b/);
  assert.doesNotMatch(html, /\bsrc=""/);
  assert.doesNotMatch(html, new RegExp(staleUrl.replaceAll("/", "\\/")));
  assert.match(html, /NOW/);
  assert.match(html, /PRINTING/);
}

test("CANONICAL READY renders actual image markup and audit attributes", () => {
  const html = render(resolve("1START00590"));
  assert.match(
    html,
    /src="\/card-thumbnails\/1START00590-gold-sample-1\.jpg"/,
  );
  assert.match(html, /data-thumbnail-resolution-kind="CANONICAL"/);
  assert.match(html, /data-thumbnail-mode="SAMPLE"/);
  assert.match(html, /data-thumbnail-source-id="sample:1"/);
  assert.match(html, /data-thumbnail-approval-status="HUMAN_APPROVED"/);
  assert.match(html, /data-thumbnail-render-status="READY"/);
  assert.match(html, /class="object-scale-down /);
  assert.doesNotMatch(html, /object-cover/);
  assert.doesNotMatch(html, /data-thumbnail-crop-spec=/);
});

test("LEGACY_COMPAT READY renders only its validated URL with contain", () => {
  const html = render(resolve("ORDINARY0001", "/card-thumbnails/ordinary.jpg"));
  assert.match(html, /src="\/card-thumbnails\/ordinary\.jpg"/);
  assert.match(html, /data-thumbnail-resolution-kind="LEGACY_COMPAT"/);
  assert.match(html, /data-thumbnail-mode="LEGACY_UNCLASSIFIED"/);
  assert.match(
    html,
    /data-thumbnail-source-id="videos\.card_thumbnail_url"/,
  );
  assert.match(html, /data-thumbnail-approval-status="UNREVIEWED"/);
  assert.match(html, /data-thumbnail-render-status="READY"/);
  assert.match(html, /class="object-contain /);
  assert.doesNotMatch(html, /data-thumbnail-crop-spec=/);
});

test("invalid canonical inputs omit img and stale URLs", () => {
  const cases = [
    ["1NAMH500006", null],
  ];
  for (const [code, renderStatus] of cases) {
    const html = render(resolve(code));
    assertPlaceholder(html);
    assert.match(
      html,
      new RegExp(
        `data-thumbnail-resolution-kind="${
          code === "1NAMH500006" ? "NON_RENDERABLE" : "CANONICAL"
        }"`,
      ),
      code,
    );
    if (renderStatus) {
      assert.match(
        html,
        new RegExp(`data-thumbnail-render-status="${renderStatus}"`),
        code,
      );
    }
  }
});

test("Phase 3A READY decisions render approved sources without provenance leakage", () => {
  const cases = [
    [
      "AQUGL00004",
      "SAMPLE",
      "data-thumbnail-source-id=\"sample:1\"|auto-right|b7f305ea|85b6fe7a",
      "sample:12",
      "object-scale-down",
    ],
    [
      "1SBP00423",
      "SCENE_FULL",
      "auto-right|scene-portrait",
      "scene:pl",
      "object-contain",
    ],
    [
      "H_1784FT000062",
      "PACKAGE_FULL",
      "auto-right",
      "dvd:full",
      "object-contain",
    ],
    [
      "H_1784FT000064",
      "PACKAGE_FULL",
      "auto-right",
      "dvd:full",
      "object-contain",
    ],
  ];
  for (const [code, mode, forbidden, sourceId, fit] of cases) {
    const html = render(resolve(code));
    assert.match(html, /<img\b/, code);
    assert.match(html, new RegExp(`data-thumbnail-mode="${mode}"`), code);
    assert.match(
      html,
      new RegExp(`data-thumbnail-source-id="${sourceId}"`),
      code,
    );
    assert.match(html, /data-thumbnail-render-status="READY"/, code);
    assert.match(html, new RegExp(`class="${fit} `), code);
    assert.doesNotMatch(html, new RegExp(forbidden), code);
    assert.doesNotMatch(
      html,
      /source_hash|output_hash|source_path_or_url|tmp\/card-thumbnail/,
      code,
    );
  }
});

test("SCENE_FULL renders contain with no crop", () => {
  const decision = adaptHumanApprovalRecord({
    code: "SCENESSR0001",
    mode: "scene_full",
    state: "RESOLVED",
    source_id: "scene:approved",
    source_path_or_url: "public/card-thumbnails/scene-approved.jpg",
    source_hash: HASH,
    output_path_or_url: "/card-thumbnails/scene-approved.jpg",
    output_hash: HASH,
    approved_by: "SSR_TEST",
    approved_at: "2026-07-30",
    reason: "SSR test fixture for an approved uncropped scene",
  });
  const resolution = resolveThumbnailPresentation({
    code: "SCENESSR0001",
    human_decision: decision,
    legacy_runtime_override: null,
    legacy_card_url: "/card-thumbnails/stale.jpg",
  });
  const html = render(resolution);
  assert.match(html, /data-thumbnail-mode="SCENE_FULL"/);
  assert.match(html, /class="object-contain /);
  assert.doesNotMatch(html, /data-thumbnail-crop-spec=/);
});

test("PACKAGE_RIGHT renders cover and the exact package mode", () => {
  const html = render(resolve("5561SGKT00002"));
  assert.match(html, /data-thumbnail-mode="PACKAGE_RIGHT"/);
  assert.match(html, /data-thumbnail-source-id="dvd:right"/);
  assert.match(html, /class="object-cover /);
});

test("approved SCENE_CROP exposes the exact crop contract", () => {
  const crop = { unit: "pixel", x: 30, y: 0, width: 315, height: 450 };
  const decision = adaptHumanApprovalRecord({
    code: "SCENESSR0002",
    mode: "scene_crop",
    state: "RESOLVED",
    source_id: "scene:approved-crop",
    source_path_or_url: "public/card-thumbnails/scene-crop.jpg",
    source_hash: HASH,
    output_path_or_url: "/card-thumbnails/scene-crop.jpg",
    output_hash: HASH,
    crop_spec: crop,
    approved_by: "SSR_TEST",
    approved_at: "2026-07-30",
    reason: "SSR test fixture for an approved scene crop",
  });
  const resolution = resolveThumbnailPresentation({
    code: "SCENESSR0002",
    human_decision: decision,
    legacy_runtime_override: null,
  });
  const html = render(resolution);
  assert.match(html, /data-thumbnail-mode="SCENE_CROP"/);
  assert.match(html, /class="object-cover /);
  assert.match(
    html,
    /data-thumbnail-crop-spec="\{&quot;unit&quot;:&quot;pixel&quot;,&quot;x&quot;:30,&quot;y&quot;:0,&quot;width&quot;:315,&quot;height&quot;:450\}"/,
  );
});
