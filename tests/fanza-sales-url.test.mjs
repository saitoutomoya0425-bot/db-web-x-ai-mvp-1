import assert from "node:assert/strict";
import test from "node:test";
import { resolveSalesUrl } from "../src/lib/fanza/sales-url.ts";

test("FANZA API affiliate links remain preferred after API link activation", () => {
  const result = resolveSalesUrl(
    "https://al.fanza.co.jp/?af_id=test-990&ch=api&lurl=https%3A%2F%2Fvideo.dmm.co.jp%2Fav%2Fcontent%2F%3Fid%3Dabc",
    "https://video.dmm.co.jp/av/content/?id=abc",
  );
  assert.deepEqual(result, {
    url: "https://al.fanza.co.jp/?af_id=test-990&ch=api&lurl=https%3A%2F%2Fvideo.dmm.co.jp%2Fav%2Fcontent%2F%3Fid%3Dabc",
    isAffiliate: true,
  });
});

test("verified non-broken affiliate links remain preferred", () => {
  const result = resolveSalesUrl(
    "https://www.dmm.co.jp/digital/videoa/-/detail/=/cid=abc/",
    "https://video.dmm.co.jp/av/content/?id=abc",
  );
  assert.equal(result?.isAffiliate, true);
});
