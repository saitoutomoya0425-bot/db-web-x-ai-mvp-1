import test from "node:test";
import assert from "node:assert/strict";
import {
  catalogPublicationEligibilityReasons,
  isOfficialSalesUrl,
} from "../src/lib/catalog/publication-safety.ts";

const eligible = {
  product_code: "ABC-001",
  title: "公開可能作品",
  actress_name: "架空女優",
  card_thumbnail_url: "/card-thumbnails/ABC-001.jpg",
  thumbnail_url: "https://pics.dmm.co.jp/mono/movie/adult/abc001/abc001pl.jpg",
  official_url: "https://video.dmm.co.jp/av/content/?id=abc001",
  affiliate_url: "https://al.fanza.co.jp/?lurl=https%3A%2F%2Fvideo.dmm.co.jp",
  source_name: "FANZA Webサービス",
  external_product_id: "abc001",
};

test("publication gate accepts only a complete catalog record with an actress relation", () => {
  assert.deepEqual(catalogPublicationEligibilityReasons(eligible, {
    hasActressRelation: true,
    hasSourceRelation: true,
    hasDuplicate: false,
  }), []);
});

test("publication gate blocks missing provenance, sales URLs, image, and actress relation", () => {
  assert.deepEqual(catalogPublicationEligibilityReasons({
    product_code: "",
    title: "",
    actress_name: null,
    card_thumbnail_url: null,
    thumbnail_url: null,
    official_url: null,
    affiliate_url: null,
    source_name: null,
    external_product_id: null,
  }, {
    hasActressRelation: false,
    hasSourceRelation: false,
    hasDuplicate: false,
  }), [
    "normalized_product_code_missing",
    "title_missing",
    "source_provenance_missing",
    "external_product_id_missing",
    "official_url_not_allowed",
    "affiliate_url_missing",
    "image_missing",
    "actress_metadata_missing",
    "actress_relation_missing",
    "source_relation_missing",
  ]);
});

test("publication gate rejects insecure sales URLs and untrusted images", () => {
  assert.equal(isOfficialSalesUrl("http://video.dmm.co.jp/item"), false);
  assert.equal(isOfficialSalesUrl("https://user:pass@video.dmm.co.jp/item"), false);
  assert.equal(isOfficialSalesUrl("https://video.dmm.co.jp:8443/item"), false);
  assert.deepEqual(catalogPublicationEligibilityReasons({
    ...eligible,
    official_url: "http://video.dmm.co.jp/item",
    affiliate_url: "https://example.test/affiliate",
    card_thumbnail_url: "https://example.test/image.jpg",
    thumbnail_url: null,
  }, {
    hasActressRelation: true,
    hasSourceRelation: true,
    hasDuplicate: false,
  }), [
    "official_url_not_allowed",
    "affiliate_url_not_allowed",
    "image_url_not_allowed",
  ]);
});

test("publication gate blocks a duplicate even when all fields and relations are complete", () => {
  assert.deepEqual(catalogPublicationEligibilityReasons(eligible, {
    hasActressRelation: true,
    hasSourceRelation: true,
    hasDuplicate: true,
  }), ["duplicate_detected"]);
});
