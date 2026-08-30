import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  distributionMetrics,
  markExistingCandidates,
  mergePriorityCandidates,
  priorityCandidateFromRaw,
  selectPriorityCandidates,
} from "../scripts/lib/fanza-priority.mjs";

const raw = (id, date, review = undefined, maker = "maker") => ({
  content_id: id,
  product_id: id,
  date: `${date} 10:00:00`,
  review,
  imageURL: { large: `https://pics.dmm.co.jp/${id}.jpg` },
  iteminfo: { maker: [{ name: maker }] },
});
const candidate = (id, date, sort, position = 1, review = undefined) => priorityCandidateFromRaw(
  raw(id, date, review),
  { asOf: "2026-08-29", sort, position },
);

test("recent official-ranked works outrank old works and rank orders equal-freshness works", () => {
  const popularRecent = candidate("popular", "2026-08-20", "rank", 1);
  const lessPopularRecent = candidate("less", "2026-08-20", "rank", 100);
  const oldPopular = candidate("old", "2025-01-01", "rank", 1);
  assert.ok(popularRecent.priority_score > lessPopularRecent.priority_score);
  assert.ok(popularRecent.priority_score > oldPopular.priority_score);
  const selected = selectPriorityCandidates({
    rankCandidates: [oldPopular, lessPopularRecent, popularRecent],
    latestCandidates: [], backfillCandidates: [], targetSize: 300,
  });
  assert.equal(selected.candidates[0].external_product_id, "popular");
  assert.equal(selected.candidates.some((row) => row.external_product_id === "old"), false);
});

test("LATEST protects very new works even when they have no rank or review signal", () => {
  const latest = candidate("brandnew", "2026-08-29", "date", 1);
  const selected = selectPriorityCandidates({
    rankCandidates: [], latestCandidates: [latest], backfillCandidates: [], targetSize: 300,
  });
  assert.equal(selected.candidates[0].lane, "LATEST");
  assert.deepEqual(selected.candidates[0].reason, ["LATEST_0_7_DAY_PROTECTION"]);
  assert.equal(latest.official_popularity_signal, "NONE");
  assert.equal(latest.official_review_signal, "NONE");
});

test("lane targets are deterministic 60/25/15 and ordering is stable", () => {
  const rank = Array.from({ length: 200 }, (_, index) => candidate(`r${index}`, "2026-08-01", "rank", index + 1));
  const latest = Array.from({ length: 100 }, (_, index) => candidate(`l${index}`, "2026-08-28", "date", index + 1));
  const backfill = Array.from({ length: 100 }, (_, index) => candidate(`b${index}`, "2025-01-01", "backfill", index + 1));
  const first = selectPriorityCandidates({ rankCandidates: rank, latestCandidates: latest, backfillCandidates: backfill, targetSize: 300 });
  const second = selectPriorityCandidates({ rankCandidates: [...rank].reverse(), latestCandidates: [...latest].reverse(), backfillCandidates: [...backfill].reverse(), targetSize: 300 });
  assert.deepEqual(first.targets, { RECENT_POPULAR: 180, LATEST: 75, BACKFILL: 45 });
  assert.deepEqual(first.candidates.map((row) => row.external_product_id), second.candidates.map((row) => row.external_product_id));
  assert.equal(first.candidates.length, 300);
});

test("an undersupplied popular lane is filled with latest candidates, never extra old backfill", () => {
  const rank = Array.from({ length: 10 }, (_, index) => candidate(`r${index}`, "2026-08-01", "rank", index + 1));
  const latest = Array.from({ length: 300 }, (_, index) => candidate(`l${index}`, "2026-08-28", "date", index + 1));
  const backfill = Array.from({ length: 300 }, (_, index) => candidate(`b${index}`, "2025-01-01", "backfill", index + 1));
  const selected = selectPriorityCandidates({ rankCandidates: rank, latestCandidates: latest, backfillCandidates: backfill, targetSize: 300 });
  assert.equal(selected.candidates.length, 300);
  assert.equal(selected.candidates.filter((row) => row.lane === "BACKFILL").length, 45);
  assert.equal(selected.candidates.filter((row) => row.lane === "LATEST").length, 245);
  assert.ok(selected.candidates[0].release_age_days <= 30);
  assert.notEqual(selected.candidates[0].lane, "BACKFILL");
});

test("duplicate rank/date results merge once and retain the official rank signal", () => {
  const ranked = candidate("same", "2026-08-20", "rank", 9, { count: 2, average: "4.5" });
  const dated = candidate("same", "2026-08-20", "date", 1);
  const merged = mergePriorityCandidates([dated, ranked, ranked]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].query_sorts, ["date", "rank"]);
  assert.equal(merged[0].official_rank_position, 9);
  assert.match(merged[0].official_review_signal, /count:2/);
});

test("exact DB identities are marked before any image processing", () => {
  const rows = markExistingCandidates(
    [candidate("existing", "2026-08-20", "date"), candidate("new", "2026-08-20", "date")],
    new Set(["existing"]),
    new Set(),
  );
  assert.equal(rows[0].already_exists, true);
  assert.equal(rows[1].already_exists, false);
  assert.ok(rows[0].reason.includes("EXACT_DB_MATCH"));
});

test("unknown popularity and malformed review fields fail closed", () => {
  const unknown = candidate("unknown", "2026-08-20", "date", 1, { count: "bad", average: 99 });
  assert.equal(unknown.official_popularity_signal, "NONE");
  assert.equal(unknown.official_review_signal, "NONE");
  assert.equal(unknown.official_rank_position, null);
});

test("priority metrics favor a fresh mix over the old backfill control", () => {
  const priority = [candidate("new", "2026-08-28", "date")];
  const old = [candidate("old", "2025-01-01", "backfill")];
  assert.ok(distributionMetrics(priority).median_release_age_days < distributionMetrics(old).median_release_age_days);
});

test("runner is read-only, does not fetch images, and does not contain persistence operations", async () => {
  const source = await readFile(new URL("../scripts/fanza-priority-candidates.mjs", import.meta.url), "utf8");
  assert.match(source, /begin\("read only"/);
  assert.match(source, /sort: "rank"/);
  assert.match(source, /sort: "date"/);
  assert.doesNotMatch(source, /\b(insert into|update public|delete from|create table|alter table)\b/i);
  assert.doesNotMatch(source, /sampleImageURL[^\n]*fetch|imageURL[^\n]*fetch/);
  assert.doesNotMatch(source, /promotion|publishFanza|saveCandidate/i);
});
