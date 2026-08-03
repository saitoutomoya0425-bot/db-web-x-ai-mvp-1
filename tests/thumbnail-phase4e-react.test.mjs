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

test("Phase 4E card and detail SSR use the approved uncropped sample:1 contract", () => {
  const cardSource = readFileSync(
    new URL("../src/components/public-work-card.tsx", import.meta.url),
    "utf8",
  );
  const detailSource = readFileSync(
    new URL("../src/app/work/[product_code]/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(cardSource, /aspect-\[7\/10\]/);
  assert.match(cardSource, /<ResolvedThumbnail/);
  assert.match(detailSource, /resolveThumbnailPresentation/);
  assert.match(detailSource, /<ResolvedThumbnail/);
  for (const [code, url] of Object.entries(expected)) {
    const resolution = resolveThumbnailPresentation({
      code,
      legacy_card_url: `/card-thumbnails/${code}-auto-right.jpg`,
      legacy_thumbnail_url: `https://pics.dmm.co.jp/digital/video/${code.toLowerCase()}/${code.toLowerCase()}jp-99.jpg`,
    });
    const surfaces = [
      ["card", "relative aspect-[7/10] overflow-hidden", "50vw"],
      ["detail", "relative aspect-[3/4] overflow-hidden", "560px"],
    ];
    const rendered = surfaces.map(([surface, className, sizes]) => {
      const html = renderToStaticMarkup(createElement("div", {
        "data-surface": surface,
        className,
      }, createElement(ResolvedThumbnail, {
        resolution,
        alt: `${code} Phase 4E ${surface} SSR`,
        sizes,
        className,
        imageClassName: "object-center",
      })));
      assert.match(html, new RegExp(`src="${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`), `${code}:${surface}`);
      assert.match(html, /data-thumbnail-resolution-kind="CANONICAL"/, `${code}:${surface}`);
      assert.match(html, /data-thumbnail-mode="SAMPLE"/, `${code}:${surface}`);
      assert.match(html, /data-thumbnail-source-id="sample:1"/, `${code}:${surface}`);
      assert.match(html, /data-thumbnail-approval-status="HUMAN_APPROVED"/, `${code}:${surface}`);
      assert.match(html, /data-thumbnail-render-status="READY"/, `${code}:${surface}`);
      assert.match(html, /class="object-scale-down /, `${code}:${surface}`);
      assert.doesNotMatch(html, /object-cover/, `${code}:${surface}`);
      assert.match(html, /object-position:center/, `${code}:${surface}`);
      assert.doesNotMatch(html, /data-thumbnail-crop-spec=/, `${code}:${surface}`);
      for (const sample of rejected[code]) {
        assert.doesNotMatch(html, new RegExp(`jp-${sample}\\.jpg`), `${code}:${surface}:sample:${sample}`);
      }
      assert.doesNotMatch(html, /auto-right/, `${code}:${surface}`);
      return html;
    });
    for (const html of rendered) {
      assert.equal((html.match(/<img\b/g) ?? []).length, 1, code);
    }
  }
});
