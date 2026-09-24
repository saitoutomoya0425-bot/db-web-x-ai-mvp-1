import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  isMyFansPublicEnabled,
  loadMyFansPublicWhenEnabled,
} from "../src/lib/myfans/public-feature.ts";
import {
  myFansMediaTypeLabel,
  myFansPublicDetailHref,
  toMyFansPublicWork,
} from "../src/lib/myfans/public-ui.ts";
import {
  composeSourceAwarePublicWorks,
  toFanzaPublicWork,
} from "../src/lib/public-catalog/source-aware.ts";

const id = "123e4567-e89b-12d3-a456-426614174000";
const row = {
  external_post_id: id,
  title: "Synthetic MyFans title",
  canonical_outbound_url: `https://myfans.jp/posts/${id}`,
  price: 1980,
  currency: "JPY",
  media_type: "video",
  affiliate_link_status: "missing",
  affiliate_url: null,
  show_affiliate_cta: false,
  external_creator_id: "profile_slug:synthetic.creator",
  creator_profile_slug: "synthetic.creator",
  creator_display_name: "Synthetic Creator",
  creator_canonical_url: "https://myfans.jp/synthetic.creator",
  source_badge: "MyFans",
};

const fanzaWork = {
  id: "fanza-id",
  product_code: "ABC-123",
  title: "Synthetic FANZA work",
};

test("feature flag defaults false and accepts only exact true", () => {
  assert.equal(isMyFansPublicEnabled(undefined), false);
  assert.equal(isMyFansPublicEnabled("false"), false);
  assert.equal(isMyFansPublicEnabled("TRUE"), false);
  assert.equal(isMyFansPublicEnabled("true"), true);
});

test("disabled feature returns zero MyFans rows without invoking its loader", async () => {
  let calls = 0;
  const works = await loadMyFansPublicWhenEnabled(false, async () => {
    calls += 1;
    return [row];
  });
  assert.deepEqual(works, []);
  assert.equal(calls, 0);
});

test("enabled simulation accepts 100 approved projection candidates", async () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({ ...row, external_post_id: `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000` }));
  const works = await loadMyFansPublicWhenEnabled(true, async () => rows);
  assert.equal(works.length, 100);
});

test("disabled source-aware composition preserves FANZA order and object identity", () => {
  const second = { ...fanzaWork, id: "fanza-id-2", product_code: "XYZ-456" };
  const result = composeSourceAwarePublicWorks({
    fanzaWorks: [fanzaWork, second],
    myFansWorks: [toMyFansPublicWork(row)],
    myFansEnabled: false,
  });
  assert.deepEqual(result.map((item) => item.source), ["fanza", "fanza"]);
  assert.equal(result[0].source === "fanza" && result[0].legacyWork, fanzaWork);
  assert.equal(result[1].source === "fanza" && result[1].legacyWork, second);
  assert.equal(toFanzaPublicWork(fanzaWork).detailHref, "/work/ABC-123");
});

test("MyFans public model is text-only and uses a collision-free route", () => {
  const work = toMyFansPublicWork(row);
  assert.ok(work);
  assert.equal(work.source, "myfans");
  assert.equal(work.detailHref, `/work/myfans/${id}`);
  assert.notEqual(work.detailHref, `/work/${id}`);
  assert.deepEqual(work.placeholder, { kind: "local_neutral", label: "画像は掲載していません" });
  assert.equal("thumbnailUrl" in work, false);
  assert.equal("imageUrl" in work, false);
  assert.equal("avatarUrl" in work, false);
  assert.equal("legacyWork" in work, false);
});

test("canonical CTA remains separate from a missing affiliate CTA", () => {
  const work = toMyFansPublicWork(row);
  assert.ok(work);
  assert.equal(work.canonicalCtaLabel, "MyFansで作品を見る");
  assert.equal(work.canonicalOutboundUrl, row.canonical_outbound_url);
  assert.equal(work.showAffiliateCta, false);
  assert.equal(work.affiliateUrl, null);
});

test("ACTIVE valid affiliate URL alone enables the affiliate CTA", () => {
  const affiliateUrl = `https://myfans.jp/posts/${id}?affiliate=synthetic`;
  const work = toMyFansPublicWork({
    ...row,
    affiliate_link_status: "active",
    affiliate_url: affiliateUrl,
    show_affiliate_cta: true,
  });
  assert.ok(work);
  assert.equal(work.showAffiliateCta, true);
  assert.equal(work.affiliateUrl, affiliateUrl);
});

test("null price and unknown media remain safe", () => {
  const work = toMyFansPublicWork({ ...row, price: null, media_type: "unknown" });
  assert.ok(work);
  assert.equal(work.priceJpy, null);
  assert.equal(myFansMediaTypeLabel(work.mediaType), null);
});

test("invalid identity, currency, or canonical URL fails closed", () => {
  assert.equal(toMyFansPublicWork({ ...row, external_post_id: "not-a-uuid" }), null);
  assert.equal(toMyFansPublicWork({ ...row, currency: "USD" }), null);
  assert.equal(toMyFansPublicWork({ ...row, canonical_outbound_url: "https://example.test/post" }), null);
  assert.equal(myFansPublicDetailHref("not-a-uuid"), null);
});

test("enabled aggregation blends sources without inventing FANZA fields for MyFans", () => {
  const myFansWork = toMyFansPublicWork(row);
  assert.ok(myFansWork);
  const result = composeSourceAwarePublicWorks({
    fanzaWorks: [fanzaWork, { ...fanzaWork, product_code: "B-2" }, { ...fanzaWork, product_code: "C-3" }],
    myFansWorks: [myFansWork],
    myFansEnabled: true,
    limit: 4,
  });
  assert.deepEqual(result.map((item) => item.source), ["fanza", "fanza", "fanza", "myfans"]);
  assert.equal("product_code" in myFansWork, false);
  assert.equal("actress" in myFansWork, false);
  assert.equal("maker" in myFansWork, false);
});

test("MyFans components contain no remote image or FANZA media reuse", async () => {
  const [card, detail] = await Promise.all([
    readFile(new URL("../src/components/source-aware-public-work-card.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/myfans-public-work-detail.tsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(card, /next\/image|<img\b|officialFanzaImageUrl|getLegacyRuntimeThumbnailOverride/i);
  assert.doesNotMatch(detail, /next\/image|<img\b|officialFanzaImageUrl|getLegacyRuntimeThumbnailOverride/i);
  assert.match(card, /work[.]placeholder[.]label/);
  assert.match(detail, /canonicalCtaLabel/);
  assert.match(detail, /showAffiliateCta && work[.]affiliateUrl/);
});

test("disabled detail route fails closed before its database query", async () => {
  const source = await readFile(new URL("../src/app/work/myfans/[post_id]/page.tsx", import.meta.url), "utf8");
  const gate = source.indexOf("if (!isMyFansPublicEnabled()) notFound()");
  const query = source.indexOf("getMyFansPublicWorkById((await params).post_id)", gate);
  assert.ok(gate >= 0);
  assert.ok(query > gate);
});

test("public query adapter is server-only and the environment default is disabled", async () => {
  const [querySource, environment] = await Promise.all([
    readFile(new URL("../src/lib/queries/myfans-public.ts", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
  ]);
  assert.match(querySource, /^import "server-only";/);
  assert.match(environment, /^MYFANS_PUBLIC_ENABLED=false$/m);
  assert.doesNotMatch(environment, /NEXT_PUBLIC_MYFANS_PUBLIC_ENABLED/);
});

test("sitemap and private preview remain aggregate-only and disabled-safe", async () => {
  const [sitemap, preview] = await Promise.all([
    readFile(new URL("../src/app/sitemaps/[page]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/myfans-public-ui-preview.ts", import.meta.url), "utf8"),
  ]);
  assert.match(sitemap, /getMyFansPublicSitemapWorks/);
  assert.match(preview, /set transaction read only/i);
  assert.doesNotMatch(preview, /\b(insert|update|delete)\b/i);
  assert.doesNotMatch(preview, /profile_image_url|thumbnail_url|raw_public_metadata/i);
  assert.match(preview, /individualValuesLogged: 0/);
});
