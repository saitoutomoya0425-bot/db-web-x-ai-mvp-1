import test from "node:test";
import assert from "node:assert/strict";
import { normalizeFanzaItem, normalizeProductCodeValue } from "../src/lib/fanza/normalize.ts";
import { officialFanzaImageUrl } from "../src/lib/fanza/media.ts";

test("keeps the official product id while producing a comparison key", () => {
  assert.deepEqual(normalizeProductCodeValue("ipx-123"), {
    original: "ipx-123", display: "IPX-123", normalized: "IPX123",
  });
});

test("normalizes documented ItemList fields without inventing missing values", () => {
  const item = normalizeFanzaItem({
    content_id: "example001",
    product_id: "abc-001",
    title: "確認作品",
    date: "2026-07-04 10:00:00",
    URL: "https://example.test/item",
    affiliateURL: "https://example.test/affiliate",
    imageURL: { large: "https://example.test/large.jpg" },
    sampleImageURL: { sample_l: { image: ["https://example.test/1.jpg"] } },
    sampleMovieURL: { size_720_480: "https://example.test/sample.mp4" },
    prices: { price: "1,980" },
    iteminfo: {
      actress: [{ id: 1, name: "女優A" }],
      maker: [{ id: 2, name: "メーカーA" }],
      series: [{ id: 3, name: "シリーズA" }],
      genre: [{ id: 4, name: "ドラマ" }],
    },
  });
  assert.equal(item.externalProductId, "example001");
  assert.equal(item.productCode, "ABC-001");
  assert.equal(item.normalizedProductCode, "ABC001");
  assert.deepEqual(item.actressNames, ["女優A"]);
  assert.deepEqual(item.genres, ["ドラマ"]);
  assert.equal(item.releaseDate, "2026-07-04");
  assert.equal(item.price, 1980);
  assert.equal(item.description, null);
});

test("allows only official FANZA image hosts", () => {
  assert.equal(officialFanzaImageUrl("https://pics.dmm.co.jp/sample.jpg"), "https://pics.dmm.co.jp/sample.jpg");
  assert.equal(officialFanzaImageUrl("https://example.com/sample.jpg"), null);
  assert.equal(officialFanzaImageUrl("http://pics.dmm.co.jp/sample.jpg"), null);
});
