import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

export const PROMOTION_STATES = Object.freeze([
  "PENDING",
  "PROMOTE_STARTED",
  "PROMOTE_CONFIRMED",
  "TIMEOUT_AWAITING_SETTLE",
  "SETTLE_CONFIRMED",
  "UNRESOLVED",
  "FAILED",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/i;
const COMPLETED_STATES = new Set(["PROMOTE_CONFIRMED", "SETTLE_CONFIRMED"]);
const TERMINAL_STATES = new Set([...COMPLETED_STATES, "UNRESOLVED", "FAILED"]);

const isoNow = () => new Date().toISOString();
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const normalizeCode = (value) => String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

function percentile(sorted, ratio) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function stateCounts(entries) {
  return Object.fromEntries(PROMOTION_STATES.map((state) => [
    state,
    entries.filter((entry) => entry.state === state).length,
  ]));
}

export function validatePromotionInput(raw, {
  expectedCount,
  expectedFrontierMembershipSha256,
} = {}) {
  const sources = Array.isArray(raw) ? raw : raw?.sources;
  const topLevelMembership = Array.isArray(raw) ? null : raw?.frontier_membership_sha256;
  if (!Array.isArray(sources)) throw new Error("SOURCE_INPUT_ARRAY_REQUIRED");
  if (!Number.isInteger(expectedCount) || expectedCount < 1) {
    throw new Error("EXPECTED_COUNT_POSITIVE_INTEGER_REQUIRED");
  }
  if (sources.length !== expectedCount) {
    throw new Error(`SOURCE_INPUT_COUNT_MISMATCH_${sources.length}_${expectedCount}`);
  }
  if (!SHA256.test(expectedFrontierMembershipSha256 ?? "")) {
    throw new Error("EXPECTED_FRONTIER_MEMBERSHIP_SHA256_REQUIRED");
  }
  if (topLevelMembership && topLevelMembership !== expectedFrontierMembershipSha256) {
    throw new Error("FOREIGN_FRONTIER_TOP_LEVEL_MISMATCH");
  }

  const normalized = sources.map((source, index) => {
    if (!source || typeof source !== "object") throw new Error(`SOURCE_INPUT_INVALID_${index + 1}`);
    const sourceId = String(source.source_id ?? "").trim();
    const productCode = String(source.product_code ?? "").trim().toUpperCase();
    const externalProductId = String(source.external_product_id ?? "").trim();
    const membership = String(source.frontier_membership_sha256 ?? topLevelMembership ?? "").trim();
    if (!UUID.test(sourceId)) throw new Error(`SOURCE_ID_INVALID_${index + 1}`);
    if (!productCode || !normalizeCode(productCode)) throw new Error(`PRODUCT_CODE_INVALID_${index + 1}`);
    if (!externalProductId) throw new Error(`EXTERNAL_PRODUCT_ID_INVALID_${index + 1}`);
    if (membership !== expectedFrontierMembershipSha256) {
      throw new Error(`FOREIGN_FRONTIER_SOURCE_${sourceId}`);
    }
    return Object.freeze({
      source_id: sourceId,
      product_code: productCode,
      external_product_id: externalProductId,
      frontier_membership_sha256: membership,
    });
  });
  const ids = normalized.map((source) => source.source_id);
  if (new Set(ids).size !== ids.length) throw new Error("DUPLICATE_SOURCE_ID_REJECTED");
  return Object.freeze(normalized);
}

export function validateInspectedSources(input, rows) {
  if (!Array.isArray(rows)) throw new Error("SOURCE_INSPECTION_ARRAY_REQUIRED");
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (byId.size !== input.length) throw new Error(`UNKNOWN_SOURCE_COUNT_${input.length - byId.size}`);
  const result = new Map();
  for (const source of input) {
    const row = byId.get(source.source_id);
    if (!row) throw new Error(`UNKNOWN_SOURCE_${source.source_id}`);
    if (
      String(row.external_product_id ?? "") !== source.external_product_id ||
      normalizeCode(row.normalized_product_code) !== normalizeCode(source.product_code)
    ) {
      throw new Error(`FOREIGN_INPUT_SOURCE_MISMATCH_${source.source_id}`);
    }
    let status;
    if (row.review_status === "promoted" && row.promoted_video_id) status = "completed";
    else if (row.review_status === "pending" && row.preview_status === "new") status = "pending";
    else if (row.review_status === "error") status = "failed";
    else status = "foreign";
    result.set(source.source_id, Object.freeze({
      status,
      review_status: row.review_status,
      preview_status: row.preview_status,
      promoted_video_id: row.promoted_video_id ?? null,
    }));
  }
  return result;
}

async function fsyncDirectory(directory) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writePromotionCheckpointAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, filePath);
    await fsyncDirectory(directory);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function createCheckpoint(input, frontierMembershipSha256, clock) {
  const createdAt = clock();
  return {
    version: 1,
    frontier_membership_sha256: frontierMembershipSha256,
    expected_count: input.length,
    created_at: createdAt,
    updated_at: createdAt,
    sources: input.map((source) => ({
      ...source,
      state: "PENDING",
      mutation_attempts: 0,
      mutation_started_at: null,
      mutation_finished_at: null,
      request_elapsed_ms: null,
      timeout: false,
      settle_checks: 0,
      settled_at: null,
      error_code: null,
    })),
  };
}

function validateCheckpoint(checkpoint, input, frontierMembershipSha256) {
  if (
    checkpoint?.version !== 1 ||
    checkpoint.frontier_membership_sha256 !== frontierMembershipSha256 ||
    checkpoint.expected_count !== input.length ||
    !Array.isArray(checkpoint.sources) ||
    checkpoint.sources.length !== input.length
  ) {
    throw new Error("PROMOTION_CHECKPOINT_CONTRACT_MISMATCH");
  }
  for (let index = 0; index < input.length; index += 1) {
    const expected = input[index];
    const actual = checkpoint.sources[index];
    if (
      actual.source_id !== expected.source_id ||
      actual.product_code !== expected.product_code ||
      actual.external_product_id !== expected.external_product_id ||
      actual.frontier_membership_sha256 !== frontierMembershipSha256 ||
      !PROMOTION_STATES.includes(actual.state) ||
      !Number.isInteger(actual.mutation_attempts) ||
      actual.mutation_attempts < 0 ||
      actual.mutation_attempts > 1
    ) {
      throw new Error(`PROMOTION_CHECKPOINT_SOURCE_MISMATCH_${index + 1}`);
    }
  }
  return checkpoint;
}

export async function loadPromotionCheckpoint({
  checkpointPath,
  input,
  frontierMembershipSha256,
  clock = isoNow,
}) {
  try {
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    return validateCheckpoint(checkpoint, input, frontierMembershipSha256);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const checkpoint = createCheckpoint(input, frontierMembershipSha256, clock);
  await writePromotionCheckpointAtomic(checkpointPath, checkpoint);
  return checkpoint;
}

function updateSource(checkpoint, sourceId, patch, clock) {
  const source = checkpoint.sources.find((candidate) => candidate.source_id === sourceId);
  if (!source) throw new Error(`CHECKPOINT_SOURCE_NOT_FOUND_${sourceId}`);
  Object.assign(source, patch);
  checkpoint.updated_at = clock();
  return source;
}

function isTimeout(error) {
  return error?.name === "AbortError" || error?.name === "TimeoutError" || error?.code === "PROMOTE_TIMEOUT";
}

export async function runPromotionQueue({
  input,
  frontierMembershipSha256,
  checkpointPath,
  inspectSources,
  mutateSource,
  mode = "dry-run",
  concurrency = 1,
  settleChecks = 2,
  settleDelayMs = 30_000,
  progressEvery = 25,
  logger = (line) => console.log(line),
  clock = isoNow,
  monotonicNow = () => performance.now(),
  sleep = delay,
}) {
  if (!["write", "dry-run", "reconcile-only"].includes(mode)) throw new Error("PROMOTION_MODE_INVALID");
  if (![1, 2].includes(concurrency)) throw new Error("PROMOTION_CONCURRENCY_1_OR_2_REQUIRED");
  if (!Number.isInteger(settleChecks) || settleChecks < 1 || settleChecks > 2) {
    throw new Error("SETTLE_CHECKS_1_OR_2_REQUIRED");
  }
  if (!Number.isInteger(progressEvery) || progressEvery < 1) throw new Error("PROGRESS_INTERVAL_INVALID");

  const totalStarted = monotonicNow();
  const checkpoint = await loadPromotionCheckpoint({
    checkpointPath,
    input,
    frontierMembershipSha256,
    clock,
  });
  let persistTail = Promise.resolve();
  const persist = () => {
    const snapshot = structuredClone(checkpoint);
    persistTail = persistTail.then(() => writePromotionCheckpointAtomic(checkpointPath, snapshot));
    return persistTail;
  };
  const initialInspection = validateInspectedSources(input, await inspectSources(input.map((source) => source.source_id)));
  const inspectionById = initialInspection;

  for (const source of checkpoint.sources) {
    const inspection = inspectionById.get(source.source_id);
    if (inspection.status === "foreign") throw new Error(`FOREIGN_SOURCE_STATE_${source.source_id}`);
    if (inspection.status === "completed") {
      if (!COMPLETED_STATES.has(source.state)) {
        updateSource(checkpoint, source.source_id, {
          state: source.mutation_attempts ? "SETTLE_CONFIRMED" : "PROMOTE_CONFIRMED",
          mutation_finished_at: source.mutation_finished_at ?? clock(),
          settled_at: source.mutation_attempts ? clock() : source.settled_at,
          error_code: null,
        }, clock);
      }
      continue;
    }
    if (inspection.status === "failed") {
      updateSource(checkpoint, source.source_id, { state: "FAILED", error_code: "SOURCE_ALREADY_FAILED" }, clock);
      continue;
    }
    if (source.state === "PROMOTE_STARTED") {
      updateSource(checkpoint, source.source_id, {
        state: "UNRESOLVED",
        timeout: true,
        error_code: "CRASH_AFTER_MUTATION_START_REQUIRES_MANUAL_REVIEW",
      }, clock);
    } else if (COMPLETED_STATES.has(source.state)) {
      updateSource(checkpoint, source.source_id, {
        state: "UNRESOLVED",
        error_code: "COMPLETED_CHECKPOINT_DB_NOT_COMPLETED",
      }, clock);
    }
  }
  await persist();

  if (mode !== "write") {
    const counts = stateCounts(checkpoint.sources);
    return {
      mode,
      total: input.length,
      completed: counts.PROMOTE_CONFIRMED + counts.SETTLE_CONFIRMED,
      would_mutate: checkpoint.sources.filter((source) => source.state === "PENDING").length,
      unknown: 0,
      foreign: 0,
      mutation_attempts: 0,
      duplicate_mutations: 0,
      blind_retries: 0,
      counts,
      elapsed_ms: monotonicNow() - totalStarted,
    };
  }

  const pending = checkpoint.sources.filter((source) => source.state === "PENDING");
  let cursor = 0;
  let processed = 0;
  let lastMutationFinishedAt = null;
  const requestDurations = [];
  const idleGaps = [];
  let mutationActiveMs = 0;
  let settleWaitMs = 0;
  let networkRequestsThisRun = 0;

  async function worker() {
    while (cursor < pending.length) {
      const source = pending[cursor];
      cursor += 1;
      if (source.mutation_attempts !== 0) throw new Error(`MUTATION_ALREADY_ATTEMPTED_${source.source_id}`);
      const requestStarted = monotonicNow();
      if (lastMutationFinishedAt !== null) idleGaps.push(Math.max(0, requestStarted - lastMutationFinishedAt));
      updateSource(checkpoint, source.source_id, {
        state: "PROMOTE_STARTED",
        mutation_attempts: 1,
        mutation_started_at: clock(),
        error_code: null,
      }, clock);
      await persist();
      try {
        networkRequestsThisRun += 1;
        const result = await mutateSource(source);
        const elapsed = monotonicNow() - requestStarted;
        requestDurations.push(elapsed);
        mutationActiveMs += elapsed;
        if (result?.status !== "confirmed") {
          updateSource(checkpoint, source.source_id, {
            state: "FAILED",
            mutation_finished_at: clock(),
            request_elapsed_ms: elapsed,
            error_code: result?.error_code ?? "PROMOTE_NOT_CONFIRMED",
          }, clock);
        } else {
          updateSource(checkpoint, source.source_id, {
            state: "PROMOTE_CONFIRMED",
            mutation_finished_at: clock(),
            request_elapsed_ms: elapsed,
            error_code: null,
          }, clock);
        }
      } catch (error) {
        if (error?.fatalProcessCrash) throw error;
        const elapsed = monotonicNow() - requestStarted;
        requestDurations.push(elapsed);
        mutationActiveMs += elapsed;
        if (isTimeout(error)) {
          updateSource(checkpoint, source.source_id, {
            state: "TIMEOUT_AWAITING_SETTLE",
            mutation_finished_at: clock(),
            request_elapsed_ms: elapsed,
            timeout: true,
            error_code: "PROMOTE_TIMEOUT",
          }, clock);
        } else {
          updateSource(checkpoint, source.source_id, {
            state: "FAILED",
            mutation_finished_at: clock(),
            request_elapsed_ms: elapsed,
            error_code: error?.code ?? "PROMOTE_FAILED",
          }, clock);
        }
      }
      lastMutationFinishedAt = monotonicNow();
      await persist();
      processed += 1;
      if (processed % progressEvery === 0 || processed === pending.length) {
        const counts = stateCounts(checkpoint.sources);
        logger(`PROMOTE ${processed}/${pending.length} confirmed ${counts.PROMOTE_CONFIRMED} timeouts ${counts.TIMEOUT_AWAITING_SETTLE} unresolved ${counts.UNRESOLVED} elapsed_ms ${Math.round(monotonicNow() - totalStarted)}`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  for (let check = 1; check <= settleChecks; check += 1) {
    const awaiting = checkpoint.sources.filter((source) => source.state === "TIMEOUT_AWAITING_SETTLE");
    if (!awaiting.length) break;
    if (check > 1 && settleDelayMs > 0) {
      const waitStarted = monotonicNow();
      await sleep(settleDelayMs);
      settleWaitMs += monotonicNow() - waitStarted;
    }
    const inspections = validateInspectedSources(
      input.filter((source) => awaiting.some((entry) => entry.source_id === source.source_id)),
      await inspectSources(awaiting.map((source) => source.source_id)),
    );
    for (const source of awaiting) {
      const inspection = inspections.get(source.source_id);
      source.settle_checks += 1;
      if (inspection.status === "completed") {
        updateSource(checkpoint, source.source_id, {
          state: "SETTLE_CONFIRMED",
          settled_at: clock(),
          error_code: null,
        }, clock);
      } else if (inspection.status === "failed") {
        updateSource(checkpoint, source.source_id, {
          state: "FAILED",
          error_code: "SOURCE_SETTLED_FAILED",
        }, clock);
      }
    }
    await persist();
  }

  for (const source of checkpoint.sources.filter((entry) => entry.state === "TIMEOUT_AWAITING_SETTLE")) {
    updateSource(checkpoint, source.source_id, {
      state: "UNRESOLVED",
      error_code: "SETTLE_NOT_CONFIRMED",
    }, clock);
  }
  await persist();

  const counts = stateCounts(checkpoint.sources);
  const sortedDurations = [...requestDurations].sort((left, right) => left - right);
  const sortedGaps = [...idleGaps].sort((left, right) => left - right);
  const mutationAttempts = checkpoint.sources.reduce((sum, source) => sum + source.mutation_attempts, 0);
  const totalElapsed = monotonicNow() - totalStarted;
  return {
    mode,
    total: input.length,
    completed: counts.PROMOTE_CONFIRMED + counts.SETTLE_CONFIRMED,
    mutation_attempts: mutationAttempts,
    network_requests_this_run: networkRequestsThisRun,
    duplicate_mutations: checkpoint.sources.filter((source) => source.mutation_attempts > 1).length,
    blind_retries: 0,
    timeouts: checkpoint.sources.filter((source) => source.timeout).length,
    settles: counts.SETTLE_CONFIRMED,
    counts,
    total_elapsed_ms: totalElapsed,
    mutation_active_ms: mutationActiveMs,
    idle_ms: Math.max(0, totalElapsed - mutationActiveMs - settleWaitMs),
    settle_wait_ms: settleWaitMs,
    request_avg_ms: sortedDurations.length ? sortedDurations.reduce((sum, value) => sum + value, 0) / sortedDurations.length : 0,
    request_p50_ms: percentile(sortedDurations, 0.5),
    request_p95_ms: percentile(sortedDurations, 0.95),
    idle_gap_avg_ms: sortedGaps.length ? sortedGaps.reduce((sum, value) => sum + value, 0) / sortedGaps.length : 0,
    idle_gap_p95_ms: percentile(sortedGaps, 0.95),
    terminal: checkpoint.sources.every((source) => TERMINAL_STATES.has(source.state)),
  };
}
