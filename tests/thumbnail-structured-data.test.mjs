import test from "node:test";
import assert from "node:assert/strict";
import { resolveThumbnailPresentation } from "../src/lib/thumbnail/presentation.ts";
import {
  resolvedThumbnailPublicUrl,
  thumbnailStructuredDataImage,
} from "../src/lib/thumbnail/structured-data.ts";

const resolve = (code) =>
  resolveThumbnailPresentation({
    code,
    legacy_runtime_override: null,
    legacy_card_url: "/card-thumbnails/stale.jpg",
    legacy_thumbnail_url: "https://pics.dmm.co.jp/stale.jpg",
  });

test("local READY output becomes a public absolute structured-data URL", () => {
  const resolution = resolve("13DSVR01990");
  assert.equal(
    resolvedThumbnailPublicUrl(resolution, "https://example.test/base/path"),
    "https://example.test/card-thumbnails/13DSVR01990-gold-sample-1.jpg",
  );
  assert.deepEqual(
    thumbnailStructuredDataImage(resolution, "https://example.test"),
    {
      thumbnailUrl: [
        "https://example.test/card-thumbnails/13DSVR01990-gold-sample-1.jpg",
      ],
      image:
        "https://example.test/card-thumbnails/13DSVR01990-gold-sample-1.jpg",
    },
  );
});

test("trusted external READY output remains the same HTTPS URL", () => {
  const resolution = resolve("BEBL00058");
  const expected =
    "https://pics.dmm.co.jp/digital/video/bebl00058/bebl00058jp-4.jpg";
  assert.equal(
    resolvedThumbnailPublicUrl(resolution, "https://example.test"),
    expected,
  );
  assert.deepEqual(
    thumbnailStructuredDataImage(resolution, "https://example.test"),
    { thumbnailUrl: [expected], image: expected },
  );
});

test("pending, review, and invalid resolutions omit image properties", () => {
  for (const code of [
    "AQUGL00004",
    "1SBP00423",
    "H_1784FT000062",
    "1NAMH500006",
  ]) {
    const fields = thumbnailStructuredDataImage(
      resolve(code),
      "https://example.test",
    );
    assert.deepEqual(fields, {}, code);
    assert.equal("image" in fields, false, code);
    assert.equal("thumbnailUrl" in fields, false, code);
  }
});

test("invalid site bases fail closed for local outputs", () => {
  const resolution = resolve("13DSVR01990");
  assert.equal(resolvedThumbnailPublicUrl(resolution, ""), null);
  assert.equal(
    resolvedThumbnailPublicUrl(resolution, "http://localhost:3000"),
    null,
  );
  assert.equal(
    resolvedThumbnailPublicUrl(resolution, "http://example.test"),
    null,
  );
  assert.equal(resolvedThumbnailPublicUrl(resolution, "javascript:alert(1)"), null);
  assert.equal(
    resolvedThumbnailPublicUrl(resolution, "https://user@example.test"),
    null,
  );
});
