import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  loadPromotionCheckpoint,
  runPromotionQueue,
  validateInspectedSources,
  validatePromotionInput,
  writePromotionCheckpointAtomic,
} from "../scripts/lib/fanza-promotion-runner.mjs";

const MEMBERSHIP = "a".repeat(64);

function source(index) {
  return {
    source_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    product_code: `TEST${String(index).padStart(5, "0")}`,
    external_product_id: `test${String(index).padStart(5, "0")}`,
    frontier_membership_sha256: MEMBERSHIP,
  };
}

function input(count) {
  return validatePromotionInput({
    frontier_membership_sha256: MEMBERSHIP,
    sources: Array.from({ length: count }, (_, index) => source(index + 1)),
  }, {
    expectedCount: count,
    expectedFrontierMembershipSha256: MEMBERSHIP,
  });
}

function row(item, status = "pending") {
  return {
    id: item.source_id,
    external_product_id: item.external_product_id,
    normalized_product_code: item.product_code,
    review_status: status === "completed" ? "promoted" : status === "failed" ? "error" : "pending",
    preview_status: "new",
    promoted_video_id: status === "completed" ? `video-${item.source_id}` : null,
  };
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fanza-promotion-runner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, checkpointPath: path.join(directory, "promotion-state.json") };
}

test("exact input rejects count mismatch, duplicate ids and foreign frontier", () => {
  assert.throws(() => validatePromotionInput([source(1)], {
    expectedCount: 2,
    expectedFrontierMembershipSha256: MEMBERSHIP,
  }), /SOURCE_INPUT_COUNT_MISMATCH/);
  assert.throws(() => validatePromotionInput([source(1), source(1)], {
    expectedCount: 2,
    expectedFrontierMembershipSha256: MEMBERSHIP,
  }), /DUPLICATE_SOURCE_ID_REJECTED/);
  assert.throws(() => validatePromotionInput([{ ...source(1), frontier_membership_sha256: "b".repeat(64) }], {
    expectedCount: 1,
    expectedFrontierMembershipSha256: MEMBERSHIP,
  }), /FOREIGN_FRONTIER_SOURCE/);
});

test("inspection rejects unknown and foreign source rows", () => {
  const sources = input(1);
  assert.throws(() => validateInspectedSources(sources, []), /UNKNOWN_SOURCE_COUNT/);
  assert.throws(() => validateInspectedSources(sources, [{ ...row(sources[0]), external_product_id: "other" }]), /FOREIGN_INPUT_SOURCE_MISMATCH/);
});

test("dry-run and reconcile-only never invoke mutation", async (t) => {
  const { checkpointPath } = await fixture(t);
  const sources = input(3);
  let mutations = 0;
  const inspectSources = async (ids) => ids.map((id) => row(sources.find((item) => item.source_id === id), id === sources[0].source_id ? "pending" : "completed"));
  const mutateSource = async () => { mutations += 1; return { status: "confirmed" }; };
  const dryRun = await runPromotionQueue({
    input: sources,
    frontierMembershipSha256: MEMBERSHIP,
    checkpointPath,
    inspectSources,
    mutateSource,
    mode: "dry-run",
  });
  assert.equal(dryRun.would_mutate, 1);
  assert.equal(dryRun.completed, 2);
  assert.equal(dryRun.mutation_attempts, 0);
  const reconcile = await runPromotionQueue({
    input: sources,
    frontierMembershipSha256: MEMBERSHIP,
    checkpointPath,
    inspectSources,
    mutateSource,
    mode: "reconcile-only",
  });
  assert.equal(reconcile.mutation_attempts, 0);
  assert.equal(mutations, 0);
});

test("default c1 sends one source per request and compact progress", async (t) => {
  const { checkpointPath } = await fixture(t);
  const sources = input(30);
  let active = 0;
  let maxActive = 0;
  const calls = [];
  const logs = [];
  const result = await runPromotionQueue({
    input: sources,
    frontierMembershipSha256: MEMBERSHIP,
    checkpointPath,
    inspectSources: async (ids) => ids.map((id) => row(sources.find((item) => item.source_id === id))),
    mutateSource: async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push(item.source_id);
      await Promise.resolve();
      active -= 1;
      return { status: "confirmed" };
    },
    mode: "write",
    progressEvery: 25,
    logger: (line) => logs.push(line),
  });
  assert.equal(maxActive, 1);
  assert.deepEqual(calls, sources.map((item) => item.source_id));
  assert.equal(new Set(calls).size, 30);
  assert.equal(result.mutation_attempts, 30);
  assert.equal(result.duplicate_mutations, 0);
  assert.equal(result.blind_retries, 0);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /^PROMOTE 25\/30 /);
  assert.match(logs[1], /^PROMOTE 30\/30 /);
});

test("timeout is deferred, does not block pending queue and settles timeout-only", async (t) => {
  const { checkpointPath } = await fixture(t);
  const sources = input(4);
  const statuses = new Map(sources.map((item) => [item.source_id, "pending"]));
  const events = [];
  const settleInspections = [];
  let inspectionCount = 0;
  const timeoutId = sources[0].source_id;
  const result = await runPromotionQueue({
    input: sources,
    frontierMembershipSha256: MEMBERSHIP,
    checkpointPath,
    inspectSources: async (ids) => {
      inspectionCount += 1;
      if (inspectionCount > 1) settleInspections.push([...ids]);
      events.push(`inspect:${ids.join("|")}`);
      return ids.map((id) => row(sources.find((item) => item.source_id === id), statuses.get(id)));
    },
    mutateSource: async (item) => {
      events.push(`mutate:${item.source_id}`);
      if (item.source_id === timeoutId) {
        statuses.set(item.source_id, "completed");
        const error = new Error("timeout");
        error.code = "PROMOTE_TIMEOUT";
        throw error;
      }
      statuses.set(item.source_id, "completed");
      return { status: "confirmed" };
    },
    mode: "write",
    settleChecks: 1,
    progressEvery: 10,
    logger: () => {},
  });
  assert.deepEqual(events.filter((event) => event.startsWith("mutate:")), sources.map((item) => `mutate:${item.source_id}`));
  assert.deepEqual(settleInspections, [[timeoutId]]);
  assert.equal(result.counts.PROMOTE_CONFIRMED, 3);
  assert.equal(result.counts.SETTLE_CONFIRMED, 1);
  assert.equal(result.mutation_attempts, 4);
  assert.equal(result.blind_retries, 0);
});

test("unresolved timeout and completed resume never retry mutation", async (t) => {
  const { checkpointPath } = await fixture(t);
  const sources = input(1);
  let mutations = 0;
  const inspectPending = async (ids) => ids.map((id) => row(sources.find((item) => item.source_id === id), "pending"));
  const first = await runPromotionQueue({
    input: sources,
    frontierMembershipSha256: MEMBERSHIP,
    checkpointPath,
    inspectSources: inspectPending,
    mutateSource: async () => {
      mutations += 1;
      const error = new Error("timeout");
      error.code = "PROMOTE_TIMEOUT";
      throw error;
    },
    mode: "write",
    settleChecks: 1,
    logger: () => {},
  });
  assert.equal(first.counts.UNRESOLVED, 1);
  const resumed = await runPromotionQueue({
    input: sources,
    frontierMembershipSha256: MEMBERSHIP,
    checkpointPath,
    inspectSources: inspectPending,
    mutateSource: async () => { mutations += 1; return { status: "confirmed" }; },
    mode: "write",
    settleChecks: 1,
    logger: () => {},
  });
  assert.equal(resumed.counts.UNRESOLVED, 1);
  assert.equal(mutations, 1);
  const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
  assert.equal(checkpoint.sources[0].mutation_attempts, 1);
});

test("crash after mutation start resumes fail-closed without duplicate", async (t) => {
  const { checkpointPath } = await fixture(t);
  const sources = input(1);
  let mutations = 0;
  const inspectPending = async (ids) => ids.map((id) => row(sources.find((item) => item.source_id === id), "pending"));
  await assert.rejects(runPromotionQueue({
    input: sources,
    frontierMembershipSha256: MEMBERSHIP,
    checkpointPath,
    inspectSources: inspectPending,
    mutateSource: async () => {
      mutations += 1;
      const error = new Error("synthetic crash");
      error.fatalProcessCrash = true;
      throw error;
    },
    mode: "write",
    logger: () => {},
  }), /synthetic crash/);
  const resumed = await runPromotionQueue({
    input: sources,
    frontierMembershipSha256: MEMBERSHIP,
    checkpointPath,
    inspectSources: inspectPending,
    mutateSource: async () => { mutations += 1; return { status: "confirmed" }; },
    mode: "write",
    logger: () => {},
  });
  assert.equal(resumed.counts.UNRESOLVED, 1);
  assert.equal(mutations, 1);
});

test("timeout checkpoint resumes with read-only settle before mutation", async (t) => {
  const { checkpointPath } = await fixture(t);
  const sources = input(1);
  const checkpoint = await loadPromotionCheckpoint({
    checkpointPath,
    input: sources,
    frontierMembershipSha256: MEMBERSHIP,
  });
  Object.assign(checkpoint.sources[0], {
    state: "TIMEOUT_AWAITING_SETTLE",
    mutation_attempts: 1,
    timeout: true,
    error_code: "PROMOTE_TIMEOUT",
  });
  await writePromotionCheckpointAtomic(checkpointPath, checkpoint);
  let mutations = 0;
  const result = await runPromotionQueue({
    input: sources,
    frontierMembershipSha256: MEMBERSHIP,
    checkpointPath,
    inspectSources: async (ids) => ids.map((id) => row(sources.find((item) => item.source_id === id), "completed")),
    mutateSource: async () => { mutations += 1; return { status: "confirmed" }; },
    mode: "write",
    logger: () => {},
  });
  assert.equal(result.counts.SETTLE_CONFIRMED, 1);
  assert.equal(mutations, 0);
});

test("completed resume is read-only and a DB mismatch fails closed", async (t) => {
  const { checkpointPath } = await fixture(t);
  const sources = input(1);
  let mutations = 0;
  const first = await runPromotionQueue({
    input: sources,
    frontierMembershipSha256: MEMBERSHIP,
    checkpointPath,
    inspectSources: async (ids) => ids.map((id) => row(sources.find((item) => item.source_id === id), "completed")),
    mutateSource: async () => { mutations += 1; return { status: "confirmed" }; },
    mode: "write",
    logger: () => {},
  });
  assert.equal(first.counts.PROMOTE_CONFIRMED, 1);
  assert.equal(first.network_requests_this_run, 0);

  const resumed = await runPromotionQueue({
    input: sources,
    frontierMembershipSha256: MEMBERSHIP,
    checkpointPath,
    inspectSources: async (ids) => ids.map((id) => row(sources.find((item) => item.source_id === id), "completed")),
    mutateSource: async () => { mutations += 1; return { status: "confirmed" }; },
    mode: "write",
    logger: () => {},
  });
  assert.equal(resumed.counts.PROMOTE_CONFIRMED, 1);
  assert.equal(resumed.network_requests_this_run, 0);
  assert.equal(mutations, 0);

  const inconsistent = await runPromotionQueue({
    input: sources,
    frontierMembershipSha256: MEMBERSHIP,
    checkpointPath,
    inspectSources: async (ids) => ids.map((id) => row(sources.find((item) => item.source_id === id), "pending")),
    mutateSource: async () => { mutations += 1; return { status: "confirmed" }; },
    mode: "write",
    logger: () => {},
  });
  assert.equal(inconsistent.counts.UNRESOLVED, 1);
  assert.equal(inconsistent.network_requests_this_run, 0);
  assert.equal(mutations, 0);
});

test("100-source scheduler benchmark keeps timeouts off the mutation queue", async (t) => {
  const { checkpointPath } = await fixture(t);
  const sources = input(100);
  const timeoutSettle = new Set(sources.slice(95, 98).map((item) => item.source_id));
  const timeoutUnresolved = sources[98].source_id;
  const hardFailure = sources[99].source_id;
  const statuses = new Map(sources.map((item) => [item.source_id, "pending"]));
  const attempts = new Map();
  let active = 0;
  let maxActive = 0;
  let tick = 0;
  const logs = [];
  const result = await runPromotionQueue({
    input: sources,
    frontierMembershipSha256: MEMBERSHIP,
    checkpointPath,
    inspectSources: async (ids) => ids.map((id) => row(sources.find((item) => item.source_id === id), statuses.get(id))),
    mutateSource: async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      attempts.set(item.source_id, (attempts.get(item.source_id) ?? 0) + 1);
      tick += 2;
      active -= 1;
      if (timeoutSettle.has(item.source_id) || item.source_id === timeoutUnresolved) {
        if (timeoutSettle.has(item.source_id)) statuses.set(item.source_id, "completed");
        const error = new Error("timeout");
        error.code = "PROMOTE_TIMEOUT";
        throw error;
      }
      if (item.source_id === hardFailure) return { status: "failed", error_code: "HARD_FAILURE" };
      statuses.set(item.source_id, "completed");
      return { status: "confirmed" };
    },
    mode: "write",
    settleChecks: 1,
    progressEvery: 25,
    logger: (line) => logs.push(line),
    monotonicNow: () => tick,
  });
  assert.equal(maxActive, 1);
  assert.equal(result.counts.PROMOTE_CONFIRMED, 95);
  assert.equal(result.counts.SETTLE_CONFIRMED, 3);
  assert.equal(result.counts.UNRESOLVED, 1);
  assert.equal(result.counts.FAILED, 1);
  assert.equal(result.mutation_attempts, 100);
  assert.equal(result.duplicate_mutations, 0);
  assert.equal(result.blind_retries, 0);
  assert.equal(Math.max(...attempts.values()), 1);
  assert.equal(logs.length, 4);
  assert.ok(result.total_elapsed_ms < 1000);
  const stored = JSON.parse(await readFile(checkpointPath, "utf8"));
  assert.equal(stored.sources.length, 100);
  assert.doesNotMatch(JSON.stringify(stored), /password|service_role|cookie/i);
});
