import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { dryRunCatalogImport } from "../importer/dry-run-importer.mjs";
import {
  resolutionSummary,
  resolveStagingPlan
} from "../importer/read-only-resolution.mjs";
import {
  syntheticHundredPostBundle,
  syntheticImportBundle,
  syntheticImportPost
} from "./fixtures/synthetic-import-bundles.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(testDir, "..");
const DATA_SOURCE = {
  id: "00000000-0000-4000-8000-000000009999",
  name: "MyFans Affiliate Center",
  source_type: "manual",
  is_active: true
};

function normalizedReport(posts = [syntheticImportPost()]) {
  return dryRunCatalogImport(syntheticImportBundle(posts));
}

function creatorRow(target, overrides = {}) {
  return {
    id: "00000000-0000-4000-8000-000000008001",
    data_source_id: DATA_SOURCE.id,
    ...structuredClone(target.db_row),
    data_source_id: DATA_SOURCE.id,
    ...overrides
  };
}

function postRow(target, creatorId, overrides = {}) {
  return {
    id: "00000000-0000-4000-8000-000000008101",
    ...structuredClone(target.db_row),
    data_source_id: DATA_SOURCE.id,
    creator_id: creatorId,
    ...overrides
  };
}

function resolve(report, { dataSources = [DATA_SOURCE], creators = [], posts = [] } = {}) {
  return resolveStagingPlan(
    report,
    { dataSourceCandidates: dataSources, creators, posts },
    { dbQueryCount: dataSources.length === 1 ? 3 : 1 }
  );
}

test("resolves one exact existing creator without using display name as identity", () => {
  const report = normalizedReport();
  const target = report.targets.myfans_creators[0];
  const existing = creatorRow(target);
  const result = resolve(report, { creators: [existing] });
  assert.equal(result.status, "READY");
  assert.deepEqual(result.creator_resolution, {
    EXISTING_EXACT: 1,
    NEW: 0,
    AMBIGUOUS: 0,
    CONFLICT: 0
  });
  assert.equal(result.planned_mutations.planned_creator_updates, 0);
  assert.equal(result.details.creators[0].planned_action, "NO_OP");
  assert.equal(JSON.stringify(result).includes(existing.id), false);
});

test("classifies a creator absent from the snapshot as new with a redacted temporary key", () => {
  const result = resolve(normalizedReport());
  assert.equal(result.creator_resolution.NEW, 1);
  assert.equal(result.planned_mutations.planned_creator_inserts, 1);
  assert.match(result.details.creators[0].temporary_key, /^new-creator:[0-9a-f]{16}$/);
});

test("blocks an ambiguous creator identity that resolves to two database rows", () => {
  const report = normalizedReport();
  const target = report.targets.myfans_creators[0];
  const externalMatch = creatorRow(target, {
    id: "00000000-0000-4000-8000-000000008011",
    profile_slug: "other_slug",
    official_url: "https://myfans.jp/other_slug"
  });
  const urlMatch = creatorRow(target, {
    id: "00000000-0000-4000-8000-000000008012",
    external_creator_id: "stable-source-id-12"
  });
  const result = resolve(report, { creators: [externalMatch, urlMatch] });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.creator_resolution.AMBIGUOUS, 1);
  assert.equal(result.ambiguous_count, 1);
});

test("blocks a conflicting fallback creator identity", () => {
  const report = normalizedReport();
  const target = report.targets.myfans_creators[0];
  const conflicting = creatorRow(target, {
    profile_slug: "conflicting_slug",
    official_url: "https://myfans.jp/conflicting_slug"
  });
  const result = resolve(report, { creators: [conflicting] });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.creator_resolution.CONFLICT, 1);
  assert.deepEqual(result.details.creators[0].conflict_reasons.sort(), [
    "PROFILE_SLUG_MISMATCH",
    "PROFILE_URL_MISMATCH"
  ]);
});

test("classifies an existing post with permitted fields unchanged as identical", () => {
  const report = normalizedReport();
  const creator = creatorRow(report.targets.myfans_creators[0]);
  const post = postRow(report.targets.myfans_posts[0], creator.id);
  const result = resolve(report, { creators: [creator], posts: [post] });
  assert.equal(result.post_resolution.EXISTING_IDENTICAL, 1);
  assert.equal(result.planned_mutations.planned_post_updates, 0);
  assert.equal(result.planned_mutations.planned_no_ops, 2);
});

test("classifies an allowed existing post field difference as update-needed", () => {
  const report = normalizedReport();
  const creator = creatorRow(report.targets.myfans_creators[0]);
  const post = postRow(report.targets.myfans_posts[0], creator.id, { title: "Older safe title" });
  const result = resolve(report, { creators: [creator], posts: [post] });
  assert.equal(result.post_resolution.EXISTING_UPDATE_NEEDED, 1);
  assert.equal(result.planned_mutations.planned_post_updates, 1);
  assert.deepEqual(result.details.posts[0].changed_fields, ["title"]);
});

test("blocks a conflicting existing post UUID whose canonical URL disagrees", () => {
  const report = normalizedReport();
  const creator = creatorRow(report.targets.myfans_creators[0]);
  const post = postRow(report.targets.myfans_posts[0], creator.id, {
    official_url: "https://myfans.jp/posts/00000000-0000-4000-8000-000000000999"
  });
  const result = resolve(report, { creators: [creator], posts: [post] });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.post_resolution.CONFLICT, 1);
  assert.deepEqual(result.details.posts[0].conflict_reasons, ["POST_URL_MISMATCH"]);
});

test("blocks an existing post whose creator relation conflicts", () => {
  const report = normalizedReport();
  const creator = creatorRow(report.targets.myfans_creators[0]);
  const post = postRow(report.targets.myfans_posts[0], "00000000-0000-4000-8000-000000008099");
  const result = resolve(report, { creators: [creator], posts: [post] });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.post_resolution.CONFLICT, 1);
  assert.deepEqual(result.details.posts[0].conflict_reasons, ["CREATOR_RELATION_MISMATCH"]);
});

test("simulates a second run with zero inserts, updates, ambiguity, or conflicts", () => {
  const result = resolve(normalizedReport());
  assert.equal(result.status, "READY");
  assert.deepEqual(
    {
      creator_inserts: result.second_run.creator_inserts,
      creator_updates: result.second_run.creator_updates,
      post_inserts: result.second_run.post_inserts,
      post_updates: result.second_run.post_updates,
      conflicts: result.second_run.conflicts,
      ambiguous: result.second_run.ambiguous
    },
    {
      creator_inserts: 0,
      creator_updates: 0,
      post_inserts: 0,
      post_updates: 0,
      conflicts: 0,
      ambiguous: 0
    }
  );
  assert.equal(result.second_run.pass, true);
  assert.equal(result.second_run.post_resolution.EXISTING_IDENTICAL, 1);
});

test("fails closed when the MyFans data source is absent or ambiguous", () => {
  const report = normalizedReport();
  const missing = resolve(report, { dataSources: [] });
  const ambiguous = resolve(report, {
    dataSources: [DATA_SOURCE, { ...DATA_SOURCE, id: "second", name: "MyFans duplicate" }]
  });
  assert.equal(missing.status, "BLOCKED");
  assert.deepEqual(missing.blocking_reasons, ["MYFANS_DATA_SOURCE_NOT_FOUND"]);
  assert.equal(ambiguous.status, "BLOCKED");
  assert.deepEqual(ambiguous.blocking_reasons, ["MULTIPLE_MYFANS_DATA_SOURCES"]);
});

test("keeps changed creator display metadata as an update, not an identity conflict", () => {
  const report = normalizedReport();
  const target = report.targets.myfans_creators[0];
  const existing = creatorRow(target, { display_name: "Older display name" });
  const result = resolve(report, { creators: [existing] });
  assert.equal(result.creator_resolution.EXISTING_EXACT, 1);
  assert.equal(result.planned_mutations.planned_creator_updates, 1);
  assert.deepEqual(result.details.creators[0].changed_fields, ["display_name"]);
  assert.equal(result.second_run.pass, true);
});

test("resolves a 100-record pilot-shaped plan and proves second-run idempotency", () => {
  const dryRun = dryRunCatalogImport(syntheticHundredPostBundle());
  const result = resolve(dryRun);
  assert.equal(result.status, "READY");
  assert.equal(result.planned_mutations.planned_creator_inserts, 10);
  assert.equal(result.planned_mutations.planned_post_inserts, 100);
  assert.equal(result.second_run.pass, true);
  assert.equal(result.second_run.creator_inserts, 0);
  assert.equal(result.second_run.post_inserts, 0);
  assert.equal(result.second_run.post_updates, 0);
  assert.equal(result.second_run.post_resolution.EXISTING_IDENTICAL, 100);
});

test("summary exposes only aggregate, hashed, and non-secret source metadata", () => {
  const report = resolve(normalizedReport());
  const summary = resolutionSummary(report);
  assert.match(summary.data_source.id_hash, /^data-source:[0-9a-f]{16}$/);
  assert.equal("internal_id" in summary.data_source, false);
  assert.equal("details" in summary, false);
  assert.equal(JSON.stringify(summary).includes(DATA_SOURCE.id), false);
  assert.equal(summary.db_write_count, 0);
});

test("database CLI contains exactly three bounded SELECT queries and no mutation path", async () => {
  const source = await readFile(path.join(extensionRoot, "bin/resolve-staging-plan.mjs"), "utf8");
  assert.equal((source.match(/await sql`/g) || []).length, 3);
  for (const forbidden of [
    /\bsql[.]begin\b/i,
    /\bsql[.]unsafe\b/i,
    /\binsert\s+into\b/i,
    /\bupdate\s+public[.]/i,
    /\bdelete\s+from\b/i,
    /\bupsert\b/i,
    /\bcreate\s+(?:table|index)\b/i,
    /\balter\s+table\b/i,
    /\bdrop\s+(?:table|index)\b/i,
    /@supabase\/supabase-js/,
    /\bfetch\s*\(/,
    /XMLHttpRequest/
  ]) {
    assert.equal(forbidden.test(source), false, `forbidden resolver CLI pattern: ${forbidden}`);
  }
});
