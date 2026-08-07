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
const { PRODUCTION_THUMBNAIL_DECISIONS } = await import(
  "../src/lib/thumbnail/production-registry.ts"
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

test("LEGACY_COMPAT READY renders only its validated URL with scale-down", () => {
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
  assert.match(html, /class="object-scale-down /);
  assert.match(html, /data-thumbnail-requested-fit="scale-down"/);
  assert.match(html, /data-thumbnail-upscale-policy="DENY"/);
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
      "object-scale-down",
    ],
    [
      "H_1784FT000062",
      "PACKAGE_FULL",
      "auto-right",
      "dvd:full",
      "object-scale-down",
    ],
    [
      "H_1784FT000064",
      "PACKAGE_FULL",
      "auto-right",
      "dvd:full",
      "object-scale-down",
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
    if (mode === "PACKAGE_FULL" || mode === "SCENE_FULL") {
      assert.match(html, /data-thumbnail-requested-fit="contain"/, code);
    }
    assert.doesNotMatch(html, new RegExp(forbidden), code);
    assert.doesNotMatch(
      html,
      /source_hash|output_hash|source_path_or_url|tmp\/card-thumbnail/,
      code,
    );
  }
});

test("SCENE_FULL keeps contain intent and starts from safe scale-down", () => {
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
  assert.match(html, /data-thumbnail-requested-fit="contain"/);
  assert.match(html, /data-thumbnail-effective-fit="scale-down"/);
  assert.match(html, /class="object-scale-down /);
  assert.doesNotMatch(html, /data-thumbnail-crop-spec=/);
});

test("PACKAGE_RIGHT keeps cover/right intent and starts from safe scale-down", () => {
  const html = render(resolve("5561SGKT00002"));
  assert.match(html, /data-thumbnail-mode="PACKAGE_RIGHT"/);
  assert.match(html, /data-thumbnail-source-id="dvd:right"/);
  assert.match(html, /data-thumbnail-requested-fit="cover"/);
  assert.match(html, /data-thumbnail-requested-position="right"/);
  assert.match(html, /data-thumbnail-crop-intent="ALIGN_RIGHT"/);
  assert.match(html, /data-thumbnail-effective-fit="scale-down"/);
  assert.match(html, /class="object-scale-down /);
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
  assert.match(html, /class="object-scale-down /);
  assert.doesNotMatch(html, /object-cover/);
  assert.match(html, /object-position:center/);
  assert.match(
    html,
    /data-thumbnail-crop-spec="\{&quot;unit&quot;:&quot;pixel&quot;,&quot;x&quot;:30,&quot;y&quot;:0,&quot;width&quot;:315,&quot;height&quot;:450\}"/,
  );
});

test("approved SCENE_CROP outputs share one scale-down contract across public surfaces", () => {
  const requiredRepresentatives = [
    "1SBP00416",
    "1SBP00396",
    "1SBP00395",
    "1SBP00424",
    "H_283PMFT00435",
  ];
  const cases = [...PRODUCTION_THUMBNAIL_DECISIONS.values()]
    .filter((decision) => decision.mode === "SCENE_CROP")
    .map((decision) => decision.code)
    .sort();
  assert.equal(cases.length, 29);
  for (const code of requiredRepresentatives) assert.ok(cases.includes(code));
  const surfaces = ["list", "search", "detail", "related", "recently-viewed"];

  for (const code of cases) {
    const resolution = resolve(code);
    assert.equal(resolution.resolution_kind, "CANONICAL", code);
    assert.equal(resolution.mode, "SCENE_CROP", code);
    assert.equal(resolution.source_id, "scene:pl", code);
    assert.equal(resolution.object_fit, "scale-down", code);
    assert.ok(resolution.crop_spec, code);

    for (const surface of surfaces) {
      const html = renderToStaticMarkup(
        createElement(
          "div",
          { "data-surface": surface },
          createElement(ResolvedThumbnail, {
            resolution,
            alt: `${code} ${surface}`,
            sizes: surface === "detail" ? "560px" : "50vw",
            className: "relative aspect-[7/10] overflow-hidden",
          }),
        ),
      );
      assert.match(html, /data-thumbnail-resolution-kind="CANONICAL"/, `${code}:${surface}`);
      assert.match(html, /data-thumbnail-mode="SCENE_CROP"/, `${code}:${surface}`);
      assert.match(html, /data-thumbnail-source-id="scene:pl"/, `${code}:${surface}`);
      assert.match(html, /class="object-scale-down /, `${code}:${surface}`);
      assert.doesNotMatch(html, /object-cover/, `${code}:${surface}`);
      assert.match(html, /object-position:center/, `${code}:${surface}`);
      assert.ok(
        html.includes(`src="${resolution.resolved_url}"`),
        `${code}:${surface}`,
      );
      assert.doesNotMatch(
        html,
        /source_hash|output_hash|source_path_or_url|data\/thumbnail-scene-crop-sources/,
        `${code}:${surface}`,
      );
    }
  }
});
