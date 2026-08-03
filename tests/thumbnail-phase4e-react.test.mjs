import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

register(
  new URL("./support/thumbnail-tsx-loader.mjs", import.meta.url),
  import.meta.url,
);

const { ResolvedThumbnail } = await import("../src/components/resolved-thumbnail.tsx");
const { resolveThumbnailPresentation } = await import("../src/lib/thumbnail/presentation.ts");

const expected = Object.freeze({
  KIWVR00907: "https://pics.dmm.co.jp/digital/video/kiwvr00907/kiwvr00907jp-1.jpg",
  KSBJ00438: "https://pics.dmm.co.jp/digital/video/ksbj00438/ksbj00438jp-1.jpg",
  LUCY00029: "https://pics.dmm.co.jp/digital/video/lucy00029/lucy00029jp-1.jpg",
  UMSO00650: "https://pics.dmm.co.jp/digital/video/umso00650/umso00650jp-1.jpg",
});
const rejected = Object.freeze({
  KIWVR00907: [2, 4],
  KSBJ00438: [5, 6],
  LUCY00029: [3, 6],
  UMSO00650: [9, 18],
});

test("Phase 4E PublicWorkCard SSR uses the approved 7:10 sample:1 contract", () => {
  const cardSource = readFileSync(
    new URL("../src/components/public-work-card.tsx", import.meta.url),
    "utf8",
  );
  assert.match(cardSource, /aspect-\[7\/10\]/);
  assert.match(cardSource, /<ResolvedThumbnail/);
  for (const [code, url] of Object.entries(expected)) {
    const resolution = resolveThumbnailPresentation({
      code,
      legacy_card_url: `/card-thumbnails/${code}-auto-right.jpg`,
      legacy_thumbnail_url: `https://pics.dmm.co.jp/digital/video/${code.toLowerCase()}/${code.toLowerCase()}jp-99.jpg`,
    });
    const html = renderToStaticMarkup(createElement("div", {
      className: "relative aspect-[7/10] overflow-hidden",
    }, createElement(ResolvedThumbnail, {
      resolution,
      alt: `${code} Phase 4E SSR`,
      sizes: "50vw",
      className: "relative aspect-[7/10] overflow-hidden",
      imageClassName: "object-center",
    })));
    assert.match(html, /aspect-\[7\/10\]/, code);
    assert.match(html, new RegExp(`src="${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`), code);
    assert.match(html, /data-thumbnail-resolution-kind="CANONICAL"/, code);
    assert.match(html, /data-thumbnail-mode="SAMPLE"/, code);
    assert.match(html, /data-thumbnail-source-id="sample:1"/, code);
    assert.match(html, /data-thumbnail-approval-status="HUMAN_APPROVED"/, code);
    assert.match(html, /data-thumbnail-render-status="READY"/, code);
    assert.match(html, /class="object-cover /, code);
    assert.match(html, /object-position:center/, code);
    for (const sample of rejected[code]) {
      assert.doesNotMatch(html, new RegExp(`jp-${sample}\\.jpg`), `${code}:sample:${sample}`);
    }
    assert.doesNotMatch(html, /auto-right/, code);
  }
});
