import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  FIELD_MAPPING,
  dryRunCatalogImport,
  summaryOnly
} from "../importer/dry-run-importer.mjs";
import {
  syntheticHundredPostBundle,
  syntheticImportBundle,
  syntheticImportPost
} from "./fixtures/synthetic-import-bundles.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(testDir, "..");

test("normalizes one valid post into migration 029 creator and post previews", () => {
  const report = dryRunCatalogImport(syntheticImportBundle([syntheticImportPost()]));
  assert.equal(report.status, "PASS");
  assert.equal(report.apply, false);
  assert.equal(report.db_query_count, 0);
  assert.equal(report.db_write_count, 0);
  assert.equal(report.counts.accepted, 1);
  assert.equal(report.counts.creators_discovered, 1);
  assert.equal(report.targets.myfans_creators.length, 1);
  assert.equal(report.targets.myfans_posts.length, 1);
  assert.equal(report.targets.myfans_posts[0].db_row.thumbnail_url, null);
  assert.equal(report.targets.myfans_posts[0].db_row.published_at, null);
  assert.equal(report.targets.myfans_posts[0].db_row.price, 1000);
  assert.equal(report.targets.myfans_posts[0].db_row.currency, "JPY");
  assert.equal(report.targets.myfans_posts[0].db_row.data_source_id, null);
  assert.equal(report.targets.myfans_posts[0].db_row.creator_id, null);
  assert.match(report.targets.myfans_posts[0].db_row.metadata_hash, /^[0-9a-f]{64}$/);
  assert.equal(report.targets.myfans_posts[0].unpersisted_provenance.source, "MYFANS_AFFILIATE_CENTER");
});

test("skips an identical duplicate UUID without creating a second target row", () => {
  const post = syntheticImportPost();
  const repeatedObservation = {
    ...post,
    collected_at: "2026-09-23T16:04:52.088Z",
    source_page_url: "https://www.affiliate.myfans.jp/affiliates/search?page=2"
  };
  const report = dryRunCatalogImport(syntheticImportBundle([post, repeatedObservation]));
  assert.equal(report.status, "PASS");
  assert.equal(report.counts.accepted, 1);
  assert.equal(report.counts.skipped, 1);
  assert.equal(report.counts.duplicate_uuid, 1);
  assert.equal(report.counts.duplicate_identical, 1);
  assert.equal(report.targets.myfans_posts.length, 1);
});

test("fails closed for a conflicting duplicate UUID", () => {
  const post = syntheticImportPost();
  const conflicting = { ...post, title: "Conflicting synthetic title" };
  const report = dryRunCatalogImport(syntheticImportBundle([post, conflicting]));
  assert.equal(report.status, "FIX_REQUIRED");
  assert.equal(report.normalization_pass, false);
  assert.equal(report.counts.duplicate_conflicting, 1);
  assert.equal(report.rejection_reasons.DUPLICATE_CONFLICTING_UUID, 1);
  assert.equal(report.db_write_count, 0);
});

test("rejects a missing UUID", () => {
  const report = dryRunCatalogImport(
    syntheticImportBundle([syntheticImportPost(0, { post_uuid: null })])
  );
  assert.equal(report.status, "FIX_REQUIRED");
  assert.equal(report.rejection_reasons.INVALID_OR_MISSING_POST_UUID, 1);
});

test("rejects an invalid or mismatched public post URL", () => {
  const report = dryRunCatalogImport(
    syntheticImportBundle([
      syntheticImportPost(0, { post_public_url: "https://example.test/posts/not-safe" })
    ])
  );
  assert.equal(report.status, "FIX_REQUIRED");
  assert.equal(report.rejection_reasons.MALFORMED_OR_MISMATCHED_POST_PUBLIC_URL, 1);
});

test("rejects sensitive query parameters in source-page provenance", () => {
  const report = dryRunCatalogImport(
    syntheticImportBundle([
      syntheticImportPost(0, {
        source_page_url: "https://www.affiliate.myfans.jp/affiliates/search?session=synthetic"
      })
    ])
  );
  assert.equal(report.status, "FIX_REQUIRED");
  assert.equal(report.rejection_reasons.INVALID_SOURCE_PAGE_PROVENANCE, 1);
});

test("accepts paired null price and estimated reward without inventing values", () => {
  const report = dryRunCatalogImport(
    syntheticImportBundle([
      syntheticImportPost(0, { price_jpy: null, estimated_reward_jpy: null })
    ])
  );
  assert.equal(report.status, "PASS");
  assert.equal(report.targets.myfans_posts[0].db_row.price, null);
  assert.equal(report.targets.myfans_posts[0].held_affiliate_state.estimated_reward_jpy, null);
});

test("accepts a page observation timestamp after the bundle collection start", () => {
  const report = dryRunCatalogImport(
    syntheticImportBundle([
      syntheticImportPost(0, { collected_at: "2026-09-23T16:04:52.088Z" })
    ])
  );
  assert.equal(report.status, "PASS");
  assert.equal(
    report.targets.myfans_posts[0].db_row.fetched_at,
    "2026-09-23T16:04:52.088Z"
  );
});

test("rejects malformed reward values", () => {
  const report = dryRunCatalogImport(
    syntheticImportBundle([syntheticImportPost(0, { affiliate_reward_rate: 101 })])
  );
  assert.equal(report.status, "FIX_REQUIRED");
  assert.equal(report.rejection_reasons.INVALID_AFFILIATE_REWARD_RATE, 1);
});

test("rejects an impossible negative price", () => {
  const report = dryRunCatalogImport(
    syntheticImportBundle([syntheticImportPost(0, { price_jpy: -1 })])
  );
  assert.equal(report.status, "FIX_REQUIRED");
  assert.equal(report.rejection_reasons.INVALID_PRICE_JPY, 1);
});

test("rejects a post without a stable creator identity instead of merging by name", () => {
  const report = dryRunCatalogImport(
    syntheticImportBundle([
      syntheticImportPost(0, { creator_username: null, creator_profile_url: null })
    ])
  );
  assert.equal(report.status, "FIX_REQUIRED");
  assert.equal(report.rejection_reasons.MISSING_CREATOR_IDENTITY, 1);
  assert.equal(report.targets.myfans_creators.length, 0);
});

test("keeps equal creator names separate when stable usernames differ", () => {
  const report = dryRunCatalogImport(
    syntheticImportBundle([
      syntheticImportPost(0, { creator_name: "Same Display Name", creator_username: "creator_one" }),
      syntheticImportPost(1, { creator_name: "Same Display Name", creator_username: "creator_two" })
    ])
  );
  assert.equal(report.status, "PASS");
  assert.equal(report.counts.creators_discovered, 2);
});

test("rejects an unsupported collector version", () => {
  const report = dryRunCatalogImport(
    syntheticImportBundle([syntheticImportPost()], { collector_version: "0.1.7" })
  );
  assert.equal(report.status, "FIX_REQUIRED");
  assert.equal(report.rejection_reasons.UNSUPPORTED_COLLECTOR_VERSION, 1);
  assert.equal(report.counts.accepted, 0);
});

test("rejects an unsupported collector schema", () => {
  const report = dryRunCatalogImport(
    syntheticImportBundle([syntheticImportPost()], { schema_version: "unexpected-schema" })
  );
  assert.equal(report.status, "FIX_REQUIRED");
  assert.equal(report.rejection_reasons.UNSUPPORTED_SCHEMA_VERSION, 1);
  assert.equal(report.counts.accepted, 0);
});

test("rejects prohibited image or private fields before normalization", () => {
  const post = { ...syntheticImportPost(), thumbnail_url: "https://cdn.example.test/image.jpg" };
  const report = dryRunCatalogImport(syntheticImportBundle([post]));
  assert.equal(report.status, "FIX_REQUIRED");
  assert.equal(
    Object.keys(report.rejection_reasons).some((reason) => reason.startsWith("PROHIBITED_FIELD:")),
    true
  );
  assert.equal(report.counts.accepted, 0);
});

test("normalizes a 100-record five-page pilot-shaped fixture deterministically", () => {
  const bundle = syntheticHundredPostBundle();
  const first = dryRunCatalogImport(bundle);
  const second = dryRunCatalogImport(structuredClone(bundle));
  assert.equal(first.status, "PASS");
  assert.equal(first.counts.input, 100);
  assert.equal(first.counts.accepted, 100);
  assert.equal(first.counts.rejected, 0);
  assert.equal(first.counts.skipped, 0);
  assert.equal(first.counts.creators_discovered, 10);
  assert.equal(first.counts.posts_normalized, 100);
  assert.deepEqual(first.targets, second.targets);
  assert.deepEqual(summaryOnly(first).target_counts, {
    myfans_creators: 10,
    myfans_posts: 100,
    myfans_plans: 0,
    myfans_post_plans: 0,
    video_source_link_evidence: 0
  });
});

test("documents all five field-mapping classifications", () => {
  assert.deepEqual(
    [...new Set(FIELD_MAPPING.map((entry) => entry.classification))].sort(),
    ["A", "B", "C", "D", "E"]
  );
});

test("dry-run importer and CLI have no network or database client", async () => {
  const source = (
    await Promise.all([
      readFile(path.join(extensionRoot, "importer/dry-run-importer.mjs"), "utf8"),
      readFile(path.join(extensionRoot, "bin/dry-run-import.mjs"), "utf8")
    ])
  ).join("\n");
  for (const pattern of [
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /@supabase\/supabase-js/,
    /\bpostgres\s*\(/,
    /createClient\s*\(/,
    /process\.env\.(?:DATABASE_URL|SUPABASE)/
  ]) {
    assert.equal(pattern.test(source), false, `forbidden importer pattern: ${pattern}`);
  }
});
