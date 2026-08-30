import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import postgres from "postgres";
import {
  FANZA_PRIORITY_POLICY,
  distributionMetrics,
  markExistingCandidates,
  mergePriorityCandidates,
  normalizePriorityCode,
  priorityCandidateFromRaw,
  selectPriorityCandidates,
} from "./lib/fanza-priority.mjs";

const DEFAULT_FRONTIER = path.join(
  process.env.HOME ?? "",
  "Documents/Codex/okazudb-state/fanza-frontiers/phase5d-8822-9821-0495c283/manifest.jsonl.gz",
);
const DEFAULT_OUTPUT = path.join(
  process.env.HOME ?? "",
  "Documents/Codex/okazudb-state/fanza-priority/priority-v1-dry-run-20260829",
);
const API_ENDPOINT = "https://api.dmm.com/affiliate/v3/ItemList";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const values = new Map();
for (const argument of process.argv.slice(2)) {
  if (!argument.startsWith("--") || !argument.includes("=")) throw new Error(`UNKNOWN_ARGUMENT_${argument}`);
  const [name, ...rest] = argument.slice(2).split("=");
  if (!["as-of", "target-size", "rank-pages", "latest-pages", "frontier", "output"].includes(name)) {
    throw new Error(`UNKNOWN_ARGUMENT_${argument}`);
  }
  values.set(name, rest.join("="));
}

const asOf = values.get("as-of") ?? new Date().toISOString().slice(0, 10);
const targetSize = Number(values.get("target-size") ?? 400);
const rankPages = Number(values.get("rank-pages") ?? 3);
const latestPages = Number(values.get("latest-pages") ?? 2);
const frontierPath = values.get("frontier") ?? DEFAULT_FRONTIER;
const outputDirectory = values.get("output") ?? DEFAULT_OUTPUT;
if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error("AS_OF_YYYY_MM_DD_REQUIRED");
if (!Number.isInteger(targetSize) || targetSize < 300 || targetSize > 500) throw new Error("TARGET_SIZE_300_TO_500_REQUIRED");
for (const [name, count] of [["RANK_PAGES", rankPages], ["LATEST_PAGES", latestPages]]) {
  if (!Number.isInteger(count) || count < 1 || count > 5) throw new Error(`${name}_1_TO_5_REQUIRED`);
}
for (const name of ["SUPABASE_DB_URL", "FANZA_API_ID", "FANZA_AFFILIATE_ID"]) {
  if (!process.env[name]?.trim()) throw new Error(`${name}_REQUIRED`);
}

async function atomicWrite(file, contents) {
  const temporary = `${file}.tmp-${process.pid}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

const requestKeys = new Set();
let metadataGets = 0;
async function fetchPage(sort, offset) {
  const requestKey = `${sort}:${offset}:100`;
  if (requestKeys.has(requestKey)) throw new Error("DUPLICATE_API_PAGE_REQUEST");
  requestKeys.add(requestKey);
  const params = new URLSearchParams({
    api_id: process.env.FANZA_API_ID.trim(),
    affiliate_id: process.env.FANZA_AFFILIATE_ID.trim(),
    site: process.env.FANZA_API_SITE?.trim() || "FANZA",
    service: process.env.FANZA_API_SERVICE?.trim() || "digital",
    floor: process.env.FANZA_API_FLOOR?.trim() || "videoa",
    hits: "100",
    offset: String(offset),
    sort,
    output: "json",
  });
  metadataGets++;
  const response = await fetch(`${API_ENDPOINT}?${params}`, {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`FANZA_PRIORITY_HTTP_${response.status}`);
  const payload = await response.json();
  if (Number(payload?.result?.status ?? 200) >= 400) {
    throw new Error(`FANZA_PRIORITY_API_${Number(payload?.result?.status) || "ERROR"}`);
  }
  return Array.isArray(payload?.result?.items) ? payload.result.items.slice(0, 100) : [];
}

async function fetchLane(sort, pages) {
  const rows = [];
  for (let pageIndex = 0; pageIndex < pages; pageIndex++) {
    const offset = pageIndex * 100 + 1;
    const rawItems = await fetchPage(sort, offset);
    rows.push(...rawItems.map((raw, index) => priorityCandidateFromRaw(raw, {
      asOf,
      sort,
      position: offset + index,
    })));
    if (rawItems.length < 100) break;
  }
  return mergePriorityCandidates(rows);
}

async function readBackfill() {
  const compressed = await readFile(frontierPath);
  return gunzipSync(compressed).toString("utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

function backfillCandidates(records) {
  return records.map((record, index) => {
    const raw = record.raw_payload ?? {};
    return priorityCandidateFromRaw(raw, {
      asOf,
      sort: "backfill",
      position: index + 1,
    });
  });
}

async function exactExistingLookup(candidates) {
  const externalIds = [...new Set(candidates.map((row) => row.external_product_id).filter(Boolean))];
  const codes = [...new Set(candidates.map((row) => row.normalized_product_code).filter(Boolean))];
  const sql = postgres(process.env.SUPABASE_DB_URL, {
    ssl: "require", max: 1, prepare: false, connect_timeout: 20, idle_timeout: 20,
  });
  try {
    return await sql.begin("read only", async (database) => {
      const videos = await database`
        select external_product_id, product_code
        from public.videos
        where external_product_id in ${database(externalIds)}
           or regexp_replace(upper(coalesce(product_code, '')), '[^A-Z0-9]', '', 'g') in ${database(codes)}
      `;
      const sources = await database`
        select external_product_id, normalized_product_code
        from public.source_products
        where external_product_id in ${database(externalIds)}
           or normalized_product_code in ${database(codes)}
      `;
      return {
        rowsFetched: videos.length + sources.length,
        externalIds: new Set([...videos, ...sources].map((row) => row.external_product_id).filter(Boolean)),
        codes: new Set([
          ...videos.map((row) => normalizePriorityCode(row.product_code)),
          ...sources.map((row) => row.normalized_product_code),
        ].filter(Boolean)),
      };
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function csvCell(value) {
  const text = Array.isArray(value) ? value.join("|") : String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csv(rows) {
  const fields = [
    "priority_position", "product_code", "external_product_id", "release_date", "release_age_days",
    "release_age_bucket", "lane", "official_popularity_signal", "official_review_signal",
    "priority_score", "already_exists", "reason", "maker", "series", "query_sorts",
  ];
  return `${fields.join(",")}\n${rows.map((row) => fields.map((field) => csvCell(row[field])).join(",")).join("\n")}\n`;
}

const startedAt = new Date();
const beforeFrontier = await stat(frontierPath);
const [rankCandidates, latestCandidates, frontierRecords] = await Promise.all([
  fetchLane("rank", rankPages),
  fetchLane("date", latestPages),
  readBackfill(),
]);
const selected = selectPriorityCandidates({
  rankCandidates,
  latestCandidates,
  backfillCandidates: backfillCandidates(frontierRecords),
  targetSize,
});
const existing = await exactExistingLookup(selected.candidates);
const candidates = markExistingCandidates(selected.candidates, existing.externalIds, existing.codes);
const oldComparable = markExistingCandidates(
  backfillCandidates(frontierRecords).slice(0, candidates.length),
  existing.externalIds,
  existing.codes,
);
const afterFrontier = await stat(frontierPath);
if (beforeFrontier.size !== afterFrontier.size || beforeFrontier.mtimeMs !== afterFrontier.mtimeMs) {
  throw new Error("BACKFILL_FRONTIER_CHANGED_DURING_DRY_RUN");
}

const laneCounts = Object.fromEntries(FANZA_PRIORITY_POLICY.laneOrder.map((lane) => [lane, candidates.filter((row) => row.lane === lane).length]));
const ageBuckets = Object.fromEntries(["0-7d", "8-30d", "31-90d", "91-180d", "180+d", "UNKNOWN"]
  .map((bucket) => [bucket, candidates.filter((row) => row.release_age_bucket === bucket).length]));
const generatedAt = new Date();
const summary = {
  status: "DRY_RUN_COMPLETE",
  policy_version: FANZA_PRIORITY_POLICY.version,
  generated_at: generatedAt.toISOString(),
  valid_until: new Date(generatedAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  as_of: asOf,
  candidate_target: targetSize,
  candidate_total: candidates.length,
  lane_targets: selected.targets,
  lane_counts: laneCounts,
  age_buckets: ageBuckets,
  already_existing: candidates.filter((row) => row.already_exists).length,
  potential_new_before_safety_classification: candidates.filter((row) => !row.already_exists).length,
  official_popularity_signal: "ItemList sort=rank result position",
  official_review_signal: "ItemList review.count and review.average when present",
  popularity_signal_coverage: distributionMetrics(candidates).official_popularity_coverage,
  api: {
    endpoint: API_ENDPOINT,
    queries: [
      { sort: "rank", pages: rankPages, hits: 100, offsets: Array.from({ length: rankPages }, (_, index) => index * 100 + 1) },
      { sort: "date", pages: latestPages, hits: 100, offsets: Array.from({ length: latestPages }, (_, index) => index * 100 + 1) },
    ],
    metadata_gets: metadataGets,
    duplicate_requests: 0,
    raw_api_dumps: 0,
    image_gets: 0,
    sample_gets: 0,
  },
  database: { rows_fetched: existing.rowsFetched, business_mutations: 0 },
  frontier: {
    path: frontierPath,
    records: frontierRecords.length,
    sha256: sha256(await readFile(frontierPath)),
    untouched: true,
  },
  metrics: {
    priority: distributionMetrics(candidates),
    old_backfill: distributionMetrics(oldComparable),
  },
  maker_top10: Object.entries(Object.groupBy(candidates, (row) => row.maker ?? "UNKNOWN"))
    .map(([maker, rows]) => ({ maker, count: rows.length })).sort((a, b) => b.count - a.count || a.maker.localeCompare(b.maker, "en")).slice(0, 10),
  series_top10: Object.entries(Object.groupBy(candidates, (row) => row.series ?? "UNKNOWN"))
    .map(([series, rows]) => ({ series, count: rows.length })).sort((a, b) => b.count - a.count || a.series.localeCompare(b.series, "en")).slice(0, 10),
  top50_older_than_90_days: candidates.slice(0, 50).filter((row) => row.release_age_days === null || row.release_age_days > 90).length,
  elapsed_ms: generatedAt.getTime() - startedAt.getTime(),
  save: 0,
  promote: 0,
  publish: 0,
};

await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
await Promise.all([
  atomicWrite(path.join(outputDirectory, "candidate-priority.csv"), csv(candidates)),
  atomicWrite(path.join(outputDirectory, "candidate-priority.json"), `${JSON.stringify(candidates, null, 2)}\n`),
  atomicWrite(path.join(outputDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`),
]);
console.log(JSON.stringify({ output_directory: outputDirectory, ...summary }));
