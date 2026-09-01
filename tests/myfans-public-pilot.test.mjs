import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MYFANS_ACCESS,
  MYFANS_CLASSIFICATIONS,
  MYFANS_ENTITY,
  assertFrozenSafeRecords,
  assertNoRawHtmlPersisted,
  canonicalizeMyFansRequestUrl,
  canonicalizeMyFansUrl,
  createPublicHtmlFetcher,
  creatorSlugFromUrl,
  dedupeFrozenRecords,
  detectPublicPageAccess,
  discoverCreatorCandidatesFromRanking,
  discoverPublicLinks,
  extractPublicMetadata,
  metadataHash,
  parseCreatorPage,
  parsePostPage,
  planStagingChanges,
  postIdFromUrl,
  readFrozenJsonlGzip,
  stableStringify,
  summarizeStagingPlan,
  validateMetadataUrl,
  writeFrozenJsonlGzip,
} from "../scripts/lib/myfans-public-metadata.mjs";
import { DATA_SOURCE_CONTRACT, buildPlan, main as runPilot, sourceContractState } from "../scripts/myfans-public-pilot.mjs";

const postId = "123e4567-e89b-42d3-a456-426614174000";
const creatorUrl = "https://myfans.jp/public_creator";
const postUrl = `https://myfans.jp/posts/${postId}`;
const fetchedAt = "2026-09-01T00:00:00.000Z";

function creatorHtml({ jsonName = "Public Creator", ogName = "OG Creator" } = {}) {
  return `<!doctype html><html><head>
    <script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Person", name: jsonName, url: creatorUrl, description: "Public profile excerpt", image: "https://cdn.example.test/profile.jpg" })}</script>
    <meta property="og:title" content="${ogName}">
    <meta property="og:description" content="OG profile excerpt">
    <meta property="og:url" content="${creatorUrl}">
  </head><body><a href="${postUrl}">post</a></body></html>`;
}

function postHtml({ title = "Public Post", description = "Public teaser", author = creatorUrl, published = "2026-08-31T12:34:56+09:00", accessible = true, extra = "", includeCreatorLink = true } = {}) {
  return `<!doctype html><html><head>
    <script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "SocialMediaPosting", headline: title, description, url: postUrl, author: { "@type": "Person", url: author }, datePublished: published, image: "https://cdn.example.test/post.jpg", isAccessibleForFree: accessible })}</script>
    <meta property="og:title" content="OG Post">
    <meta property="og:description" content="OG teaser">
    <meta property="og:url" content="${postUrl}">
  </head><body>${extra}${includeCreatorLink ? `<a href="${creatorUrl}">creator</a>` : ""}</body></html>`;
}

test("public creator JSON-LD is normalized with stable slug", () => {
  const record = parseCreatorPage({ html: creatorHtml(), sourceUrl: creatorUrl, fetchedAt });
  assert.equal(record.classification, MYFANS_CLASSIFICATIONS.SAFE);
  assert.equal(record.external_id, "public_creator");
  assert.equal(record.normalized.display_name, "Public Creator");
  assert.equal(record.visibility, "public");
  assert.equal(record.normalized.review_status, "public_metadata_staged");
});

test("JSON-LD is preferred over OpenGraph", () => {
  const record = parseCreatorPage({ html: creatorHtml({ jsonName: "JSON Name", ogName: "OG Name" }), sourceUrl: creatorUrl, fetchedAt });
  assert.equal(record.normalized.display_name, "JSON Name");
  assert.equal(record.raw_public_metadata.source_kind, "json_ld");
});

test("OpenGraph can normalize only when ranking structural evidence is present", () => {
  const html = `<html><head><meta property="og:title" content="OG Public Creator"><meta property="og:url" content="${creatorUrl}"><meta property="og:description" content="Short public excerpt"></head></html>`;
  const record = parseCreatorPage({ html, sourceUrl: creatorUrl, discoveryEvidence: ["RANKING_CREATOR_ITEM_ENTITY_TYPE"], fetchedAt });
  assert.equal(record.classification, MYFANS_CLASSIFICATIONS.SAFE);
  assert.equal(record.normalized.display_name, "OG Public Creator");
  assert.equal(record.raw_public_metadata.source_kind, "open_graph");
});

test("OpenGraph title and self URL alone never establish a creator entity", () => {
  const html = `<html><head><meta property="og:title" content="Generic Page"><meta property="og:url" content="${creatorUrl}"><meta property="og:description" content="Marketing"></head></html>`;
  const record = parseCreatorPage({ html, sourceUrl: creatorUrl, fetchedAt });
  assert.equal(record.access_classification, MYFANS_ACCESS.PUBLIC);
  assert.equal(record.entity_classification, MYFANS_ENTITY.REVIEW);
  assert.equal(record.classification, MYFANS_CLASSIFICATIONS.REVIEW);
  assert.equal(record.normalized, null);
});

test("stable creator identity accepts a profile slug and rejects reserved routes", () => {
  assert.equal(creatorSlugFromUrl(creatorUrl), "public_creator");
  assert.equal(creatorSlugFromUrl("https://myfans.jp/posts"), null);
  assert.equal(creatorSlugFromUrl("https://myfans.jp/unlimited"), null);
  assert.equal(creatorSlugFromUrl("https://myfans.jp/genres"), null);
  assert.equal(creatorSlugFromUrl("https://myfans.jp/a/b"), null);
});

test("public access and creator entity safety are independent contracts", () => {
  const access = detectPublicPageAccess({ status: 200, html: "<html><title>Generic</title></html>" });
  assert.equal(access.access, MYFANS_ACCESS.PUBLIC);
  const record = parseCreatorPage({ html: `<html><head><meta property="og:title" content="Generic"><meta property="og:url" content="${creatorUrl}"></head></html>`, sourceUrl: creatorUrl, fetchedAt });
  assert.equal(record.access_classification, MYFANS_ACCESS.PUBLIC);
  assert.notEqual(record.classification, MYFANS_CLASSIFICATIONS.SAFE);
});

test("known and generic navigation routes never become safe from HTTP 200 metadata", () => {
  const routes = ["unlimited", "genres", "ranking", "search", "account", "messages", "feed", "help", "unknown-navigation"];
  for (const route of routes) {
    const url = `https://myfans.jp/${route}`;
    const html = `<html><head><title>${route}</title><meta property="og:title" content="${route}"><meta property="og:description" content="Generic page"><meta property="og:url" content="${url}"></head></html>`;
    const record = parseCreatorPage({ html, sourceUrl: url, fetchedAt });
    assert.notEqual(record.classification, MYFANS_CLASSIFICATIONS.SAFE, route);
    assert.equal(record.normalized, null, route);
  }
});

test("generic marketing JSON-LD does not count as creator structural evidence", () => {
  const html = `<html><head><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "WebSite", name: "Marketing", url: creatorUrl })}</script><meta property="og:title" content="Marketing"><meta property="og:url" content="${creatorUrl}"></head></html>`;
  const record = parseCreatorPage({ html, sourceUrl: creatorUrl, fetchedAt });
  assert.equal(record.classification, MYFANS_CLASSIFICATIONS.REVIEW);
});

test("public post JSON-LD is normalized with stable UUID and known creator", () => {
  const record = parsePostPage({ html: postHtml(), sourceUrl: postUrl, knownCreatorExternalIds: ["public_creator"], fetchedAt });
  assert.equal(record.classification, MYFANS_CLASSIFICATIONS.SAFE);
  assert.equal(record.external_id, postId);
  assert.equal(record.creator_external_id, "public_creator");
  assert.equal(record.normalized.title, "Public Post");
  assert.equal(record.normalized.published_at, "2026-08-31T03:34:56.000Z");
});

test("stable post identity requires an exact official UUID route", () => {
  assert.equal(postIdFromUrl(postUrl), postId);
  assert.equal(postIdFromUrl("https://myfans.jp/posts/not-a-uuid"), null);
  assert.equal(postIdFromUrl(`${postUrl}/extra`), null);
});

test("official canonical URL strips query/hash and rejects credentials or ports", () => {
  assert.equal(canonicalizeMyFansUrl(`${postUrl}?tracking=1#x`), postUrl);
  assert.equal(canonicalizeMyFansUrl("https://user@myfans.jp/public_creator"), null);
  assert.equal(canonicalizeMyFansUrl("https://myfans.jp:444/public_creator"), null);
});

test("ranking request URL preserves only the approved daily term", () => {
  assert.equal(canonicalizeMyFansRequestUrl("https://myfans.jp/ranking/creators/all?term=daily"), "https://myfans.jp/ranking/creators/all?term=daily");
  assert.equal(canonicalizeMyFansRequestUrl("https://myfans.jp/ranking/creators/all?term=weekly"), null);
  assert.equal(canonicalizeMyFansRequestUrl("https://myfans.jp/ranking/creators/all?term=daily&token=x"), null);
});

test("signed metadata media URLs are not persisted", () => {
  assert.equal(validateMetadataUrl("https://cdn.example.test/image.jpg?token=secret"), null);
  assert.equal(validateMetadataUrl("https://cdn.example.test/image.jpg?X-Amz-Signature=secret"), null);
  assert.equal(validateMetadataUrl("https://cdn.example.test/image.jpg?width=640"), "https://cdn.example.test/image.jpg?width=640");
});

test("relative time never fabricates an absolute timestamp", () => {
  const record = parsePostPage({ html: postHtml({ published: "2 hours ago" }), sourceUrl: postUrl, knownCreatorExternalIds: ["public_creator"], fetchedAt });
  assert.equal(record.normalized.published_at, null);
});

test("paid public metadata is classified but excluded from staging", () => {
  const record = parsePostPage({ html: postHtml({ accessible: false }), sourceUrl: postUrl, knownCreatorExternalIds: ["public_creator"], fetchedAt });
  assert.equal(record.classification, MYFANS_CLASSIFICATIONS.PAID);
  assert.equal(record.visibility, "paid");
  assert.equal(record.normalized, null);
});

test("limited content is excluded", () => {
  const record = parsePostPage({ html: postHtml({ extra: "<p>フォロワー限定</p>" }), sourceUrl: postUrl, knownCreatorExternalIds: ["public_creator"], fetchedAt });
  assert.equal(record.classification, MYFANS_CLASSIFICATIONS.PAID);
  assert.equal(record.visibility, "limited");
});

test("login wall is rejected", () => {
  const record = parseCreatorPage({ html: "<html><form action='/login'>ログインしてください</form></html>", sourceUrl: creatorUrl, fetchedAt });
  assert.equal(record.classification, MYFANS_CLASSIFICATIONS.AUTH);
});

test("authentication redirect is rejected without following", () => {
  const record = parseCreatorPage({ html: "", sourceUrl: creatorUrl, fetchedAt, status: 302, location: "https://myfans.jp/login" });
  assert.equal(record.classification, MYFANS_CLASSIFICATIONS.AUTH);
  assert.deepEqual(record.reason_codes, ["AUTH_REDIRECT_REJECTED"]);
});

test("age interstitial is blocked and never bypassed", () => {
  const record = parseCreatorPage({ html: "<html><p>18歳以上であることを確認して入場</p></html>", sourceUrl: creatorUrl, fetchedAt });
  assert.equal(record.classification, MYFANS_CLASSIFICATIONS.BLOCKED);
  assert.deepEqual(record.reason_codes, ["AGE_INTERSTITIAL_NOT_BYPASSED"]);
});

test("missing stable ID is unsupported", () => {
  const record = parsePostPage({ html: postHtml(), sourceUrl: "https://myfans.jp/posts/unknown", knownCreatorExternalIds: ["public_creator"], fetchedAt });
  assert.equal(record.classification, MYFANS_CLASSIFICATIONS.UNSUPPORTED);
  assert.equal(record.normalized, null);
});

test("unknown creator identity fails closed for a public post", () => {
  const record = parsePostPage({ html: postHtml(), sourceUrl: postUrl, knownCreatorExternalIds: [], fetchedAt });
  assert.equal(record.classification, MYFANS_CLASSIFICATIONS.REVIEW);
  assert.equal(record.normalized, null);
});

test("plain author display name is never treated as a creator identity", () => {
  const record = parsePostPage({ html: postHtml({ author: "Public Creator", includeCreatorLink: false }), sourceUrl: postUrl, knownCreatorExternalIds: ["public_creator"], fetchedAt });
  assert.equal(record.classification, MYFANS_CLASSIFICATIONS.REVIEW);
  assert.equal(record.creator_external_id, null);
});

test("duplicate stable ID is classified without fuzzy matching", () => {
  const record = parseCreatorPage({ html: creatorHtml(), sourceUrl: creatorUrl, fetchedAt });
  const result = dedupeFrozenRecords([record, { ...record, source_page_hash: "b".repeat(64) }]);
  assert.equal(result[0].classification, MYFANS_CLASSIFICATIONS.SAFE);
  assert.equal(result[1].classification, MYFANS_CLASSIFICATIONS.DUPLICATE);
  assert.deepEqual(result[1].reason_codes, ["DUPLICATE_STABLE_ID"]);
});

test("duplicate official URL with a different ID is classified", () => {
  const first = parseCreatorPage({ html: creatorHtml(), sourceUrl: creatorUrl, fetchedAt });
  const second = { ...first, external_id: "different_id" };
  const result = dedupeFrozenRecords([first, second]);
  assert.equal(result[1].classification, MYFANS_CLASSIFICATIONS.DUPLICATE);
  assert.deepEqual(result[1].reason_codes, ["DUPLICATE_OFFICIAL_URL"]);
});

test("generic public link discovery only accepts structurally marked creator links", () => {
  const html = `<a data-entity-type="creator" href="${creatorUrl}">creator</a><a href="https://myfans.jp/plain_navigation">nav</a><a href="${postUrl}">post</a><a href="https://evil.example/x">external</a><a href="https://myfans.jp/image.jpg">image</a>`;
  const links = discoverPublicLinks(html);
  assert.deepEqual(links.creator_urls, [creatorUrl]);
  assert.deepEqual(links.post_urls, [postUrl]);
});

test("creator ranking discovery accepts item evidence and rejects navigation", () => {
  const rankingUrl = "https://myfans.jp/ranking/creators/all?term=daily";
  const html = `<html><head><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "ItemList", itemListElement: [{ "@type": "ListItem", position: 1, item: { "@type": "Person", name: "Public Creator", url: creatorUrl } }] })}</script></head><body><a href="https://myfans.jp/unlimited">unlimited</a><a href="https://myfans.jp/plain_navigation">plain</a><a data-entity-type="creator" href="https://myfans.jp/second_creator">second</a><a data-creator-id="different" href="https://myfans.jp/mismatched_creator">mismatch</a></body></html>`;
  const candidates = discoverCreatorCandidatesFromRanking(html, rankingUrl);
  const bySlug = new Map(candidates.map((candidate) => [candidate.candidate_slug, candidate]));
  assert.equal(bySlug.get("public_creator").rejected_reason, null);
  assert.deepEqual(bySlug.get("public_creator").positive_discovery_evidence, ["RANKING_CREATOR_ITEM_JSON_LD"]);
  assert.equal(bySlug.get("second_creator").rejected_reason, null);
  assert.equal(bySlug.get("unlimited").rejected_reason, "KNOWN_NON_CREATOR_ROUTE");
  assert.equal(bySlug.get("plain_navigation").rejected_reason, "RANKING_ITEM_STRUCTURAL_EVIDENCE_MISSING");
  assert.equal(bySlug.get("mismatched_creator").rejected_reason, "RANKING_ITEM_STRUCTURAL_EVIDENCE_MISSING");
});

test("creator ranking candidates are deduplicated by exact URL", () => {
  const rankingUrl = "https://myfans.jp/ranking/creators/all?term=daily";
  const html = `<script type="application/ld+json">${JSON.stringify({ "@type": "ItemList", itemListElement: [{ position: 1, item: { "@type": "Person", url: creatorUrl } }] })}</script><a data-testid="creator-card" href="${creatorUrl}">same</a>`;
  const candidates = discoverCreatorCandidatesFromRanking(html, rankingUrl);
  assert.equal(candidates.filter((candidate) => candidate.url === creatorUrl).length, 1);
});

test("pilot uses ranking discovery and never refetches previous false-positive routes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myfans-route-hardening-test-"));
  const outputDir = path.join(directory, "output");
  const previousDir = path.join(directory, "previous");
  const rankingUrl = "https://myfans.jp/ranking/creators/all?term=daily";
  const calls = [];
  const originalFetch = globalThis.fetch;
  await mkdir(previousDir, { recursive: true });
  await writeFile(path.join(previousDir, "creator-candidates.json"), JSON.stringify({ records: [
    { external_id: "unlimited", official_url: "https://myfans.jp/unlimited" },
    { external_id: "genres", official_url: "https://myfans.jp/genres" },
  ] }));
  const responses = new Map([
    [rankingUrl, `<html><body><a href="https://myfans.jp/unlimited">not creator</a><a data-entity-type="creator" href="${creatorUrl}">creator</a></body></html>`],
    [creatorUrl, `<html><head><meta property="og:title" content="Public Creator"><meta property="og:url" content="${creatorUrl}"></head><body><a href="${postUrl}">post</a></body></html>`],
    [postUrl, postHtml()],
  ]);
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const html = responses.get(String(url));
    assert.notEqual(html, undefined, `unexpected request: ${url}`);
    return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
  };
  try {
    const result = await runPilot([
      "--mode", "probe",
      "--output-dir", outputDir,
      "--previous-evidence-dir", previousDir,
      "--max-creators", "1",
      "--max-posts", "1",
    ]);
    assert.deepEqual(calls, [rankingUrl, creatorUrl, postUrl]);
    assert.equal(result.safe_creators, 1);
    assert.equal(result.safe_posts, 1);
    assert.equal(result.post_detail_verified, true);
    const discovery = JSON.parse(await readFile(path.join(outputDir, "discovery-candidates.json"), "utf8"));
    assert.equal(discovery.records.find((record) => record.candidate_slug === "unlimited").fetched, false);
    assert.equal(discovery.records.find((record) => record.candidate_slug === "genres").fetched, false);
    assert.equal(discovery.records.find((record) => record.candidate_slug === "public_creator").fetched, true);
    assert.doesNotMatch(await readFile(path.join(outputDir, "creator-candidates.json"), "utf8"), /<html/i);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("frozen SAFE assertions reject forged entity safety", () => {
  const valid = parseCreatorPage({ html: creatorHtml(), sourceUrl: creatorUrl, fetchedAt });
  assert.doesNotThrow(() => assertFrozenSafeRecords([valid]));
  assert.throws(() => assertFrozenSafeRecords([{ ...valid, entity_evidence: [] }]), /FROZEN_SAFE_CREATOR_ASSERTION_FAILED/);
});

test("fetcher rejects media URL before making a request", async () => {
  let calls = 0;
  const fetcher = createPublicHtmlFetcher({ fetchImpl: async () => { calls += 1; return new Response("", { status: 200, headers: { "content-type": "text/html" } }); } });
  await assert.rejects(fetcher.fetchHtml("https://myfans.jp/image.jpg"), /NON_PUBLIC_HTML_URL_REJECTED/);
  assert.equal(calls, 0);
  assert.equal(fetcher.summary().image_body_gets, 0);
  assert.equal(fetcher.summary().video_gets, 0);
});

test("same URL can generate at most one network submission", async () => {
  let calls = 0;
  const fetcher = createPublicHtmlFetcher({ fetchImpl: async () => { calls += 1; return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }); }, maxRetries: 0 });
  await fetcher.fetchHtml(creatorUrl);
  await assert.rejects(fetcher.fetchHtml(creatorUrl), /DUPLICATE_REQUEST_URL_BLOCKED/);
  assert.equal(calls, 1);
  assert.equal(fetcher.summary().duplicate_requests, 0);
});

test("a controlled network retry is capped at one", async () => {
  let calls = 0;
  const fetcher = createPublicHtmlFetcher({ fetchImpl: async () => { calls += 1; if (calls === 1) throw new TypeError("temporary network failure"); return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }); }, maxRetries: 1 });
  await fetcher.fetchHtml(creatorUrl);
  assert.equal(calls, 2);
  assert.equal(fetcher.summary().initial_requests, 1);
  assert.equal(fetcher.summary().retry_requests, 1);
});

test("request budget is enforced without an extra request", async () => {
  let calls = 0;
  const fetcher = createPublicHtmlFetcher({ fetchImpl: async () => { calls += 1; return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }); }, maxRequests: 1, maxRetries: 0 });
  await fetcher.fetchHtml(creatorUrl);
  await assert.rejects(fetcher.fetchHtml("https://myfans.jp/second_creator"), /REQUEST_BUDGET_EXCEEDED/);
  assert.equal(calls, 1);
});

test("oversized HTML is rejected without persisting its body", async () => {
  const fetcher = createPublicHtmlFetcher({
    fetchImpl: async () => new Response("x".repeat(100), { status: 200, headers: { "content-type": "text/html", "content-length": "100" } }),
    maxRetries: 0,
    maxHtmlBytes: 50,
  });
  await assert.rejects(fetcher.fetchHtml(creatorUrl), /HTML_RESPONSE_TOO_LARGE/);
  assert.equal(fetcher.summary().actual_requests, 1);
});

test("metadata hash is stable across object key order", () => {
  assert.equal(stableStringify({ b: 2, a: { d: 4, c: 3 } }), stableStringify({ a: { c: 3, d: 4 }, b: 2 }));
  assert.equal(metadataHash({ b: 2, a: 1 }), metadataHash({ a: 1, b: 2 }));
  assert.match(metadataHash({ a: 1 }), /^[0-9a-f]{64}$/);
});

test("raw HTML persistence is blocked", () => {
  assert.throws(() => assertNoRawHtmlPersisted({ raw: "<!doctype html><html></html>" }), /RAW_HTML_PERSISTENCE_BLOCKED/);
  assert.doesNotThrow(() => assertNoRawHtmlPersisted({ raw_public_metadata: { title: "Public text" } }));
});

test("lossless frozen JSONL gzip contains structured records only", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myfans-pilot-test-"));
  try {
    const file = path.join(directory, "records.jsonl.gz");
    const records = [parseCreatorPage({ html: creatorHtml(), sourceUrl: creatorUrl, fetchedAt })];
    await writeFrozenJsonlGzip(file, records);
    const restored = await readFrozenJsonlGzip(file);
    assert.deepEqual(restored, records);
    assert.doesNotMatch(JSON.stringify(restored), /<html/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("staging plan is target-scoped and idempotent", () => {
  const record = parseCreatorPage({ html: creatorHtml(), sourceUrl: creatorUrl, fetchedAt });
  const first = planStagingChanges([record], [], { targetDataSourceId: "source-1" });
  assert.deepEqual(summarizeStagingPlan(first), { NEW: 1, UNCHANGED: 0, EXISTING_CHANGED: 0, CONFLICT: 0 });
  const existing = [{ data_source_id: "source-1", external_id: record.external_id, official_url: record.official_url, metadata_hash: record.metadata_hash, visibility: "public", review_status: "public_metadata_staged" }];
  const second = planStagingChanges([record], existing, { targetDataSourceId: "source-1" });
  assert.deepEqual(summarizeStagingPlan(second), { NEW: 0, UNCHANGED: 1, EXISTING_CHANGED: 0, CONFLICT: 0 });
});

test("changed existing metadata is never automatically updated", () => {
  const record = parseCreatorPage({ html: creatorHtml(), sourceUrl: creatorUrl, fetchedAt });
  const existing = [{ data_source_id: "source-1", external_id: record.external_id, official_url: record.official_url, metadata_hash: "0".repeat(64), visibility: "public", review_status: "public_metadata_staged" }];
  const plan = planStagingChanges([record], existing, { targetDataSourceId: "source-1" });
  assert.equal(plan[0].state, "EXISTING_CHANGED");
});

test("multiple existing identity rows fail closed", () => {
  const record = parseCreatorPage({ html: creatorHtml(), sourceUrl: creatorUrl, fetchedAt });
  const existing = ["source-1", "source-2"].map((dataSourceId) => ({ data_source_id: dataSourceId, external_id: record.external_id, official_url: record.official_url, metadata_hash: record.metadata_hash, visibility: "public", review_status: "public_metadata_staged" }));
  const plan = planStagingChanges([record], existing, { targetDataSourceId: "source-1" });
  assert.equal(plan[0].state, "CONFLICT");
  assert.equal(plan[0].reason, "MULTIPLE_EXISTING_IDENTITY_ROWS");
});

test("data source contract remains inactive and exact", () => {
  assert.equal(DATA_SOURCE_CONTRACT.is_active, false);
  assert.equal(DATA_SOURCE_CONTRACT.source_type, "other");
  assert.equal(sourceContractState(null).state, "NEW");
  assert.equal(sourceContractState({ ...DATA_SOURCE_CONTRACT, id: "source-1" }).state, "UNCHANGED");
  assert.equal(sourceContractState({ ...DATA_SOURCE_CONTRACT, id: "source-1", is_active: true }).state, "CONFLICT");
});

test("DB dry-run contract is read-only and persistence is target scoped", async () => {
  const source = await readFile(new URL("../scripts/myfans-public-pilot.mjs", import.meta.url), "utf8");
  assert.match(source, /set transaction read only/);
  assert.match(source, /where external_creator_id in/);
  assert.match(source, /where p[.]external_post_id in/);
  assert.doesNotMatch(source, /on conflict/i);
  const record = parseCreatorPage({ html: creatorHtml(), sourceUrl: creatorUrl, fetchedAt });
  const plan = buildPlan({ creators: [record], posts: [] }, { source: null, creators: [], posts: [] });
  assert.equal(plan.business_mutation, 0);
  assert.equal(plan.creator.NEW, 1);
});

test("parsed public metadata contains no full HTML source", () => {
  const extracted = extractPublicMetadata(creatorHtml(), creatorUrl);
  assert.ok(extracted.jsonLd.length > 0);
  assert.doesNotMatch(JSON.stringify(parseCreatorPage({ html: creatorHtml(), sourceUrl: creatorUrl, fetchedAt })), /<!doctype|<html|<script/i);
});
