import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  composeSourceAwarePublicPage,
} from "../src/lib/public-catalog/source-aware.ts";
import {
  decodeSourceAwareCursor,
  encodeSourceAwareCursor,
  initialSourceAwareCursorState,
  sourceAwareContextHash,
} from "../src/lib/public-catalog/source-aware-cursor.ts";
import {
  createPublicSitemapPlan,
  MYFANS_SITEMAP_PAGE_SIZE,
  sliceSitemapFixture,
} from "../src/lib/public-catalog/sitemap-plan.ts";

function uuid(index) {
  return `${index.toString(16).padStart(8, "0")}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function myFansWork(index) {
  const id = uuid(index);
  return {
    source: "myfans",
    sourceBadge: "MyFans",
    stableIdentity: `myfans:${id}`,
    externalPostId: id,
    detailHref: `/work/myfans/${id}`,
    title: `MyFans ${index}`,
    creatorName: `Creator ${index % 147}`,
    creatorProfileSlug: `creator-${index % 147}`,
    priceJpy: index % 12 === 0 ? null : 1000 + index,
    currency: "JPY",
    mediaType: "unknown",
    canonicalOutboundUrl: `https://myfans.jp/posts/${id}`,
    canonicalCtaLabel: "MyFansで作品を見る",
    affiliateLinkStatus: "missing",
    affiliateUrl: null,
    showAffiliateCta: false,
    placeholder: { kind: "local_neutral", label: "画像は掲載していません" },
  };
}

function fanzaWork(index) {
  return { id: `fanza-${index}`, product_code: `FANZA-${index}`, title: `FANZA ${index}` };
}

function exhaustSources({ fanzaCount, myFansCount, pageSize = 96 }) {
  const fanza = Array.from({ length: fanzaCount }, (_, index) => fanzaWork(index));
  const myFans = Array.from({ length: myFansCount }, (_, index) => myFansWork(index));
  const encountered = [];
  let fanzaOffset = 0;
  let myFansOffset = 0;
  let interleaveIndex = 0;
  let pages = 0;
  while (fanzaOffset < fanza.length || myFansOffset < myFans.length) {
    const page = composeSourceAwarePublicPage({
      fanzaWorks: fanza.slice(fanzaOffset, fanzaOffset + pageSize + 1),
      myFansWorks: myFans.slice(myFansOffset, myFansOffset + pageSize + 1),
      myFansEnabled: true,
      limit: pageSize,
      interleaveIndex,
    });
    assert.ok(page.works.length > 0);
    encountered.push(...page.works);
    fanzaOffset += page.consumedFanza;
    myFansOffset += page.consumedMyFans;
    interleaveIndex = page.nextInterleaveIndex;
    pages += 1;
    assert.ok(pages < fanzaCount + myFansCount + 2);
  }
  return { encountered, pages };
}

test("source-aware pages preserve 3:1 policy and both source-relative orders", () => {
  const result = exhaustSources({ fanzaCount: 300, myFansCount: 100 });
  assert.deepEqual(result.encountered.slice(0, 8).map((work) => work.source), [
    "fanza", "fanza", "fanza", "myfans", "fanza", "fanza", "fanza", "myfans",
  ]);
  assert.deepEqual(
    result.encountered.filter((work) => work.source === "fanza").map((work) => work.legacyWork.product_code),
    Array.from({ length: 300 }, (_, index) => `FANZA-${index}`),
  );
  assert.deepEqual(
    result.encountered.filter((work) => work.source === "myfans").map((work) => work.externalPostId),
    Array.from({ length: 100 }, (_, index) => uuid(index)),
  );
});

test("catalog pagination reaches all 1,196 MyFans rows without duplicate or loss", () => {
  const { encountered } = exhaustSources({ fanzaCount: 5293, myFansCount: 1196 });
  const ids = encountered.filter((work) => work.source === "myfans").map((work) => work.externalPostId);
  assert.equal(ids.length, 1196);
  assert.equal(new Set(ids).size, 1196);
  assert.deepEqual(ids, Array.from({ length: 1196 }, (_, index) => uuid(index)));
});

test("one source exhaustion continues through the remaining source", () => {
  const fanzaFirst = exhaustSources({ fanzaCount: 2, myFansCount: 250 }).encountered;
  const myFansFirst = exhaustSources({ fanzaCount: 250, myFansCount: 2 }).encountered;
  assert.equal(fanzaFirst.filter((work) => work.source === "myfans").length, 250);
  assert.equal(myFansFirst.filter((work) => work.source === "fanza").length, 250);
});

test("opaque signed cursor is deterministic, context-bound, and fail-closed", () => {
  const secret = "test-only-source-aware-secret";
  const contextHash = sourceAwareContextHash("catalog:popular");
  const state = initialSourceAwareCursorState({ kind: "catalog", contextHash });
  const encoded = encodeSourceAwareCursor(state, secret);
  assert.equal(encodeSourceAwareCursor(state, secret), encoded);
  assert.deepEqual(decodeSourceAwareCursor(encoded, { kind: "catalog", contextHash }, secret), state);
  assert.equal(decodeSourceAwareCursor(`${encoded}x`, { kind: "catalog", contextHash }, secret), null);
  assert.equal(decodeSourceAwareCursor(encoded, { kind: "search", contextHash }, secret), null);
  assert.equal(decodeSourceAwareCursor(encoded, { kind: "catalog", contextHash: sourceAwareContextHash("other") }, secret), null);
  assert.doesNotMatch(encoded, /SUPABASE|service_role|database/i);
});

test("search-style pagination retrieves more than the first 100 MyFans matches", () => {
  const { encountered } = exhaustSources({ fanzaCount: 0, myFansCount: 275, pageSize: 96 });
  const ids = encountered.map((work) => work.source === "myfans" ? work.externalPostId : "");
  assert.equal(ids.length, 275);
  assert.equal(new Set(ids).size, 275);
});

test("sitemap splits 1,196 MyFans URLs into bounded chunks exactly once", () => {
  const rows = Array.from({ length: 1196 }, (_, index) => myFansWork(index));
  const plan = createPublicSitemapPlan({ site: "https://example.test", fanzaCount: 5293, myFansCount: rows.length });
  assert.equal(plan.myFansPages, 2);
  assert.deepEqual(plan.entries.filter((entry) => entry.includes("/myfans/")), [
    "https://example.test/sitemaps/myfans/0.xml",
    "https://example.test/sitemaps/myfans/1.xml",
  ]);
  const chunked = Array.from({ length: plan.myFansPages }, (_, page) => sliceSitemapFixture(rows, page, MYFANS_SITEMAP_PAGE_SIZE)).flat();
  assert.equal(chunked.length, 1196);
  assert.equal(new Set(chunked.map((row) => row.externalPostId)).size, 1196);
});

test("5k and 10k catalogs have no fixed 1,000-row ceiling", () => {
  for (const count of [5000, 10_000]) {
    const result = exhaustSources({ fanzaCount: 0, myFansCount: count });
    assert.equal(result.encountered.length, count);
    assert.equal(new Set(result.encountered.map((work) => work.stableIdentity)).size, count);
  }
});

test("50,001 MyFans URLs create bounded sitemap chunks beyond one index ceiling", () => {
  const plan = createPublicSitemapPlan({ site: "https://example.test/", fanzaCount: 0, myFansCount: 50_001 });
  assert.equal(plan.myFansPages, 51);
  assert.ok(plan.entries.every((entry) => entry.startsWith("https://example.test/")));
  assert.ok(plan.entries.every((entry) => !entry.includes("localhost")));
});

test("50,001 total works paginate without quadratic merging or a source ceiling", () => {
  const result = exhaustSources({ fanzaCount: 25_000, myFansCount: 25_001 });
  assert.equal(result.encountered.length, 50_001);
  assert.equal(new Set(result.encountered.map((work) => work.stableIdentity)).size, 50_001);
  assert.ok(result.pages < 600);
});

test("production adapters use bounded queries, server-only access, and crawlable next links", async () => {
  const [myFansQuery, aggregator, worksPage, searchPage, sitemapIndex, myFansSitemap, detailPage, projection] = await Promise.all([
    readFile(new URL("../src/lib/queries/myfans-public.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/queries/source-aware-public.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/works/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/search/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/sitemap.xml/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/sitemaps/myfans/[page]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/work/myfans/[post_id]/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../supabase/migrations/030_myfans_publication_foundation.sql", import.meta.url), "utf8"),
  ]);
  assert.match(myFansQuery, /^import "server-only";/);
  assert.match(myFansQuery, /\.gt\("external_post_id"/);
  assert.match(aggregator, /const fetchLimit = pageSize \+ 1/);
  assert.match(aggregator, /Promise\.all/);
  assert.doesNotMatch(aggregator, /for\s*\([^)]*\)\s*\{[^}]*await/s);
  assert.match(worksPage, /nextCursor/);
  assert.match(searchPage, /nextCursor/);
  assert.match(sitemapIndex, /createPublicSitemapPlan/);
  assert.match(myFansSitemap, /MYFANS_SITEMAP_PAGE_SIZE/);
  assert.match(detailPage, /robots: \{ index: true, follow: true \}/);
  assert.match(projection, /grant select on public\.myfans_approved_publication_projection to service_role/i);
  assert.match(projection, /revoke all on public\.myfans_approved_publication_projection from public, anon, authenticated/i);
});
