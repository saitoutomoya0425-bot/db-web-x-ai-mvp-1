import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import postgres from "postgres";
import { normalizeFanzaItem } from "../src/lib/fanza/normalize.ts";
import {
  buildFanzaFrontierAnchors,
  discoverAndCollectFanzaFrontier,
  fanzaFrontierMembershipSha256,
  fanzaFrontierPayloadMembershipSha256,
} from "../src/lib/fanza/frontier.ts";
import { stageFanzaItems } from "../src/lib/fanza/pipeline.ts";

const values = new Map();
for (const argument of process.argv.slice(2)) {
  if (!argument.startsWith("--") || !argument.includes("=")) throw new Error(`UNKNOWN_ARGUMENT_${argument}`);
  const [name, ...value] = argument.slice(2).split("=");
  values.set(name, value.join("="));
}

const parentPath = String(values.get("parent") ?? "");
const stateRoot = String(values.get("state-root") ?? "");
const expectedParentSha256 = String(values.get("expected-parent-sha256") ?? "");
const previousOffset = Number(values.get("previous-offset") ?? 0);
const searchStartOffset = Number(values.get("search-start-offset") ?? Math.max(1, previousOffset - 199));
const pageSize = Number(values.get("page-size") ?? 100);
const maxAnchorPages = Number(values.get("max-anchor-pages") ?? 25);
const minAnchorMatches = Number(values.get("min-anchor-matches") ?? 5);
const maxItems = Number(values.get("max-items") ?? 1000);
const maxWindowPages = Number(values.get("max-window-pages") ?? 20);
if (!parentPath.endsWith(".jsonl.gz") || !stateRoot || !/^[a-f0-9]{64}$/.test(expectedParentSha256)) {
  throw new Error("PARENT_STATE_ROOT_AND_EXPECTED_SHA_REQUIRED");
}
if (!Number.isInteger(previousOffset) || previousOffset < 1) throw new Error("PREVIOUS_OFFSET_INVALID");
if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 1000) throw new Error("MAX_ITEMS_1_TO_1000_REQUIRED");
for (const key of ["SUPABASE_DB_URL", "FANZA_API_ID", "FANZA_AFFILIATE_ID"]) {
  if (!process.env[key]?.trim()) throw new Error(`${key} is required`);
}

const sha256 = (input) => createHash("sha256").update(input).digest("hex");
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const normalizeCode = (value) => typeof value === "string"
  ? value.toUpperCase().replace(/[^A-Z0-9]/g, "")
  : null;

async function writeFileDurably(path, contents) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function databaseSnapshot(database) {
  const [videos] = await database`
    select count(*)::integer as count,
      count(*) filter (where is_published)::integer as public
    from public.videos
  `;
  const [sources] = await database`
    select count(*)::integer as count,
      count(*) filter (where review_status = 'pending')::integer as pending,
      count(*) filter (where preview_status = 'needs_review')::integer as needs_review
    from public.source_products
  `;
  const [jobs] = await database`select count(*)::integer as count from public.fanza_import_jobs`;
  return { videos: videos.count, public: videos.public, source_products: sources.count,
    pending: sources.pending, needs_review: sources.needs_review, jobs: jobs.count };
}

async function fetchPage(offset, requested) {
  const params = new URLSearchParams({
    api_id: process.env.FANZA_API_ID.trim(),
    affiliate_id: process.env.FANZA_AFFILIATE_ID.trim(),
    site: process.env.FANZA_API_SITE?.trim() || "FANZA",
    service: process.env.FANZA_API_SERVICE?.trim() || "digital",
    floor: process.env.FANZA_API_FLOOR?.trim() || "videoa",
    hits: String(requested),
    offset: String(offset),
    sort: "date",
    output: "json",
  });
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      const response = await fetch(`https://api.dmm.com/affiliate/v3/ItemList?${params}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
        cache: "no-store",
      });
      if (response.ok) {
        const payload = await response.json();
        if (Number(payload?.result?.status ?? 200) >= 400) {
          throw new Error(`FANZA_API_RESPONSE_${Number(payload?.result?.status) || "ERROR"}`);
        }
        const items = Array.isArray(payload?.result?.items) ? payload.result.items.slice(0, requested) : [];
        return items.map((rawPayload) => {
          const normalized = normalizeFanzaItem(rawPayload);
          if (!normalized.externalProductId) throw new Error("FANZA_LIVE_EXTERNAL_ID_MISSING");
          return {
            externalProductId: normalized.externalProductId,
            payloadHash: sha256(JSON.stringify(rawPayload)),
            payload: rawPayload,
          };
        });
      }
      if (![408, 425, 429, 500, 502, 503, 504].includes(response.status) || attempt === 3) {
        throw new Error(`FANZA_API_HTTP_${response.status}`);
      }
    } catch (error) {
      if (attempt === 3) throw error;
    }
    await wait(Math.min(4_000, 500 * 2 ** attempt));
  }
  throw new Error("FANZA_API_NO_RESPONSE");
}

const compressedParent = await readFile(parentPath);
const parentJsonl = gunzipSync(compressedParent).toString("utf8");
const parentSha256 = sha256(parentJsonl);
if (parentSha256 !== expectedParentSha256) throw new Error("PARENT_MANIFEST_SHA_MISMATCH");
const parentRecords = parentJsonl.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
if (!parentRecords.length || new Set(parentRecords.map((record) => record.external_product_id)).size !== parentRecords.length) {
  throw new Error("PARENT_MANIFEST_IDENTITY_INVALID");
}
const parentIds = new Set(parentRecords.map((record) => record.external_product_id));
const parentMembershipSha256 = fanzaFrontierMembershipSha256(parentRecords);
const anchors = buildFanzaFrontierAnchors(parentRecords, 25);
const deepestAnchor = anchors.at(-1);
if (!deepestAnchor || deepestAnchor.previous_source_offset !== previousOffset) {
  throw new Error("DEEPEST_ANCHOR_OFFSET_MISMATCH");
}

const sql = postgres(process.env.SUPABASE_DB_URL, {
  ssl: "require",
  max: 1,
  prepare: false,
  connect_timeout: 20,
  idle_timeout: 20,
});

let stagingDirectory = null;
try {
  const before = await sql.begin("read only", async (database) => databaseSnapshot(database));
  const { videos, sources } = await sql.begin("read only", async (database) => ({
    videos: await database`
      select id, product_code, title, actress_name, maker_name, series_name, genre, external_product_id
      from public.videos
    `,
    sources: await database`
      select id, external_product_id, normalized_product_code, normalized_data,
        review_status, preview_status, attempt_count, promoted_video_id, duplicate_video_id
      from public.source_products
    `,
  }));
  const discovery = await discoverAndCollectFanzaFrontier({
    anchors,
    deepestAnchorExternalId: deepestAnchor.external_product_id,
    parentExternalIds: parentIds,
    searchStartOffset,
    pageSize,
    maxAnchorPages,
    minAnchorMatches,
    windowSize: maxItems,
    maxWindowPages,
    fetchPage,
  });
  const runTimestamp = new Date().toISOString();
  const rawItems = discovery.records.map((record) => record.payload);
  const normalized = rawItems.map(normalizeFanzaItem);
  const existingRows = [
    ...videos.map((row) => ({
      id: row.id,
      kind: "video",
      externalProductId: row.external_product_id,
      normalizedProductCode: normalizeCode(row.product_code),
      title: row.title,
      actressNames: row.actress_name ? [row.actress_name] : [],
      makerName: row.maker_name,
      seriesName: row.series_name,
      genres: row.genre ? [row.genre] : [],
    })),
    ...sources.map((row) => ({
      id: row.id,
      kind: "source",
      externalProductId: row.external_product_id,
      normalizedProductCode: row.normalized_product_code,
      title: row.normalized_data?.title ?? null,
      actressNames: row.normalized_data?.actressNames ?? [],
      makerName: row.normalized_data?.makerName ?? null,
      seriesName: row.normalized_data?.seriesName ?? null,
      genres: row.normalized_data?.genres ?? [],
      reviewStatus: row.review_status,
      previewStatus: row.preview_status,
      attemptCount: row.attempt_count,
      linkedVideoId: row.promoted_video_id ?? row.duplicate_video_id,
    })),
  ];
  const lookup = {
    async byExternalIds(ids) {
      return new Map(ids.map((id) => [id, existingRows.filter((row) => row.externalProductId === id)]));
    },
    async byNormalizedCodes(codes) {
      return new Map(codes.map((code) => [code, existingRows.filter((row) => row.normalizedProductCode === code)]));
    },
  };
  const staged = await stageFanzaItems(rawItems, lookup);
  const productsById = new Map(staged.products.map((product) => [product.externalProductId, product]));
  const errorIndexes = new Map(staged.errors.map((error) => [error.index, error]));
  const counts = { EXISTING_UNCHANGED: 0, EXISTING_UPDATE: 0, SAFE_NEW: 0,
    NEEDS_REVIEW: 0, DUPLICATE: 0, INVALID: 0, ERROR: 0 };
  const records = rawItems.map((rawPayload, index) => {
    const item = normalized[index];
    const error = errorIndexes.get(index);
    const product = productsById.get(item.externalProductId);
    let classification;
    let reasons = [];
    if (error) {
      classification = "ERROR";
      reasons = [error.errorType];
    } else if (!product) {
      classification = "INVALID";
      reasons = ["staged_product_missing"];
    } else if (product.previewStatus === "new" && product.reviewReasons.length === 0) {
      classification = "SAFE_NEW";
    } else if (product.previewStatus === "unchanged") {
      classification = "EXISTING_UNCHANGED";
    } else if (product.previewStatus === "update") {
      classification = "EXISTING_UPDATE";
      reasons = product.reviewReasons;
    } else if (product.previewStatus === "duplicate"
      || product.reviewReasons.some((reason) => /duplicate|collision|ambiguous/.test(reason))) {
      classification = "DUPLICATE";
      reasons = product.reviewReasons;
    } else if (product.previewStatus === "needs_review") {
      classification = "NEEDS_REVIEW";
      reasons = product.reviewReasons;
    } else {
      classification = "INVALID";
      reasons = ["classification_unmapped"];
    }
    counts[classification]++;
    return {
      run_timestamp: runTimestamp,
      source_position: index + 1,
      source_offset: discovery.records[index].liveOffset,
      external_product_id: item.externalProductId,
      product_code: item.productCode,
      normalized_product_code: item.normalizedProductCode,
      release_date: item.releaseDate,
      payload_hash: discovery.records[index].payloadHash,
      actress_metadata_present: item.actressNames.length > 0,
      classification,
      reason_codes: reasons,
      raw_payload: rawPayload,
      normalized: item,
    };
  });
  if (records.length !== maxItems || new Set(records.map((record) => record.external_product_id)).size !== maxItems) {
    throw new Error("PHASE5D_RECORD_COUNT_OR_IDENTITY_INVALID");
  }
  const databaseWriteAllowed = staged.errors.length === 0
    && counts.INVALID === 0 && counts.ERROR === 0 && counts.DUPLICATE === 0;
  const after = await sql.begin("read only", async (database) => databaseSnapshot(database));
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("PHASE5D_DATABASE_CHANGED_DURING_FREEZE");

  const jsonl = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  const manifestSha256 = sha256(jsonl);
  const membershipSha256 = fanzaFrontierMembershipSha256(records);
  const payloadMembershipSha256 = fanzaFrontierPayloadMembershipSha256(records);
  const startLiveOffset = records[0].source_offset;
  const endLiveOffset = records.at(-1).source_offset;
  const directoryName = `phase5d-${startLiveOffset}-${endLiveOffset}-${membershipSha256.slice(0, 8)}`;
  const finalDirectory = `${stateRoot}/${directoryName}`;
  stagingDirectory = `${stateRoot}/.${directoryName}.${process.pid}.${Date.now()}`;
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await access(stateRoot, constants.W_OK);
  try {
    await access(finalDirectory);
    throw new Error("PHASE5D_FRONTIER_ALREADY_EXISTS");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(stagingDirectory, { mode: 0o700 });
  const manifestPath = `${stagingDirectory}/manifest.jsonl.gz`;
  const compressed = gzipSync(jsonl, { level: 6 });
  await writeFileDurably(manifestPath, compressed);
  const verifiedJsonl = gunzipSync(await readFile(manifestPath)).toString("utf8");
  const verifiedRecords = verifiedJsonl.trim().split("\n").filter(Boolean);
  if (sha256(verifiedJsonl) !== manifestSha256 || verifiedRecords.length !== maxItems) {
    throw new Error("PHASE5D_MANIFEST_DURABILITY_FAILURE");
  }
  const safeNewIds = records.filter((record) => record.classification === "SAFE_NEW")
    .map((record) => record.external_product_id);
  const summary = {
    status: "FROZEN",
    mode: "anchored_read_only_freeze",
    created_at: runTimestamp,
    parent_manifest_path: parentPath,
    parent_manifest_sha256: parentSha256,
    parent_membership_sha256: parentMembershipSha256,
    anchors,
    anchor_external_product_id: discovery.anchor.externalProductId,
    anchor_previous_offset: discovery.anchor.previousOffset,
    anchor_live_offset: discovery.anchor.liveOffset,
    anchor_drift: discovery.anchor.drift,
    anchor_matches_count: discovery.anchorMatches,
    anchor_payload_matches_count: discovery.anchorPayloadMatches,
    anchor_api_requests: discovery.anchorPageRequests,
    window_api_requests: discovery.windowPageRequests,
    start_live_offset: startLiveOffset,
    end_live_offset: endLiveOffset,
    fetched_unique_count: records.length,
    skipped_previous_ids_count: discovery.skippedPreviousIds,
    skipped_window_duplicates_count: discovery.skippedWindowDuplicates,
    manifest_sha256: manifestSha256,
    membership_sha256: membershipSha256,
    payload_membership_sha256: payloadMembershipSha256,
    first_external_product_id: records[0].external_product_id,
    last_external_product_id: records.at(-1).external_product_id,
    first_release_date: records[0].release_date,
    last_release_date: records.at(-1).release_date,
    classifications: counts,
    stage_errors: staged.errors.length,
    database_write_allowed: databaseWriteAllowed,
    database_before: before,
    database_after: after,
  };
  await writeFileDurably(`${stagingDirectory}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
  await writeFileDurably(`${stagingDirectory}/targets-safe-new.json`, `${JSON.stringify(safeNewIds, null, 2)}\n`);
  await fsyncDirectory(stagingDirectory);
  await rename(stagingDirectory, finalDirectory);
  stagingDirectory = null;
  await fsyncDirectory(stateRoot);
  const manifestStats = await stat(`${finalDirectory}/manifest.jsonl.gz`);
  console.log(JSON.stringify({ ...summary, persistent_directory: finalDirectory,
    manifest_compressed_bytes: manifestStats.size, safe_new_targets: safeNewIds.length }, null, 2));
} finally {
  await sql.end({ timeout: 1 });
  if (stagingDirectory) await rm(stagingDirectory, { recursive: true, force: true });
}
