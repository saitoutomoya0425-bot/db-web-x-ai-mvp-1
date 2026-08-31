import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath = new URL("../supabase/migrations/029_myfans_schema_foundation.sql", import.meta.url);
const sql = await readFile(migrationPath, "utf8");
const compact = sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();

const tables = [
  "myfans_creators",
  "myfans_posts",
  "myfans_plans",
  "myfans_post_plans",
  "video_source_link_evidence",
];

test("migration is additive and contains no data seed or existing-table rewrite", () => {
  assert.doesNotMatch(compact, /\bdrop\s+(table|column|constraint|index)\b/i);
  assert.doesNotMatch(compact, /(?:^|;)\s*(?:insert\s+into|update\s+public[.]|delete\s+from|truncate)\b/i);
  assert.doesNotMatch(compact, /alter table public\.(videos|actresses|makers|data_sources|source_products|product_offers|video_source_links)\b/i);
  assert.doesNotMatch(compact, /\b(create|alter)\s+table\s+auth\./i);
});

test("all required Phase 6B tables are created and creator identity review is deferred", () => {
  for (const table of tables) {
    assert.match(compact, new RegExp(`create table if not exists public[.]${table} \\(`, "i"));
  }
  assert.doesNotMatch(compact, /myfans_creator_identity_reviews/i);
});

test("creator and post source identities are unique", () => {
  assert.match(compact, /myfans_creators[\s\S]*unique\s*\(data_source_id, external_creator_id\)/i);
  assert.match(compact, /myfans_posts[\s\S]*unique\s*\(data_source_id, external_post_id\)/i);
  assert.match(compact, /myfans_posts_source_product_unique_idx[\s\S]*where source_product_id is not null/i);
});

test("plan identity is nullable and unique only when observed", () => {
  assert.match(compact, /external_plan_id text check \(external_plan_id is null/i);
  assert.match(compact, /myfans_plans_external_id_unique_idx[\s\S]*\(data_source_id, external_plan_id\)[\s\S]*where external_plan_id is not null/i);
});

test("visibility and review-state contracts fail closed", () => {
  assert.equal((compact.match(/visibility in \('public','free','paid_metadata_only','limited','paid','unknown'\)/gi) ?? []).length, 3);
  for (const status of [
    "public_metadata_staged",
    "needs_visibility_review",
    "needs_human_link",
    "affiliate_enrollment_required",
    "source_access_blocked",
    "paid_content_excluded",
    "invalid_source_identity",
  ]) {
    assert.equal((compact.match(new RegExp(`'${status}'`, "gi")) ?? []).length, 3);
  }
  assert.match(compact, /metadata_hash text not null check \(metadata_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/i);
});

test("post-plan relation and foreign-key behavior are explicit", () => {
  assert.match(compact, /creator_id uuid not null references public[.]myfans_creators\(id\) on delete restrict/i);
  assert.match(compact, /source_product_id uuid references public[.]source_products\(id\) on delete set null/i);
  assert.match(compact, /post_id uuid not null references public[.]myfans_posts\(id\) on delete cascade/i);
  assert.match(compact, /plan_id uuid not null references public[.]myfans_plans\(id\) on delete cascade/i);
  assert.match(compact, /primary key\(post_id, plan_id\)/i);
});

test("canonical link evidence is auditable and tied to the existing link", () => {
  assert.match(compact, /video_source_link_id uuid not null references public[.]video_source_links\(id\) on delete cascade/i);
  assert.match(compact, /match_method in \('exact_explicit','human_review','legacy','other'\)/i);
  assert.match(compact, /review_status in \('pending','approved','rejected','legacy'\)/i);
  assert.match(compact, /confidence numeric\(5,4\) not null check \(confidence >= 0 and confidence <= 1\)/i);
  assert.match(compact, /evidence_hash text not null check \(evidence_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/i);
  assert.match(compact, /reviewed_by uuid references auth[.]users\(id\) on delete set null/i);
  assert.match(compact, /review_status not in \('approved','rejected'\) or reviewed_by is not null/i);
});

test("RLS is enabled and no anonymous/public policy or privilege is granted", () => {
  for (const table of tables) {
    assert.match(compact, new RegExp(`alter table public[.]${table} enable row level security`, "i"));
  }
  assert.equal((compact.match(/create policy "admin manage [^"]+"/gi) ?? []).length, 5);
  assert.doesNotMatch(compact, /create policy "(?:public|anon)[^"]*"/i);
  assert.match(compact, /revoke all on[\s\S]*from public, anon/i);
  assert.doesNotMatch(compact, /grant [^;]+ to anon/i);
  assert.match(compact, /grant all on[\s\S]*to authenticated, service_role/i);
});

test("updated_at uses the existing trigger function", () => {
  assert.equal((compact.match(/execute function public[.]set_updated_at\(\)/gi) ?? []).length, 4);
  assert.doesNotMatch(compact, /create (?:or replace )?function public[.]set_updated_at/i);
});
