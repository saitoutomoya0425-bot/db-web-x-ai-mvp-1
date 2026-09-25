import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(testDir, "..");
const collectorSource = await readFile(path.join(extensionRoot, "src/collector-core.js"), "utf8");
const orchestratorSource = await readFile(path.join(extensionRoot, "src/orchestrator-core.js"), "utf8");
const sandbox = { URL, console };
vm.createContext(sandbox);
vm.runInContext(collectorSource, sandbox, { filename: "collector-core.js" });
vm.runInContext(orchestratorSource, sandbox, { filename: "orchestrator-core.js" });
const core = sandbox.MyFansCollectorCore;
const durable = sandbox.MyFansOrchestratorCore;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function pageUrl(page, query = "sexual_orientation=woman") {
  return `https://www.affiliate.myfans.jp/affiliates/search?${query}&page=${page}`;
}

function postFor(index, page) {
  const uuid = `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  return {
    post_uuid: uuid,
    post_public_url: `https://myfans.jp/posts/${uuid}`,
    title: `Synthetic post ${index}`,
    creator_name: `Creator ${Math.ceil(index / 4)}`,
    creator_username: `creator_${Math.ceil(index / 4)}`,
    creator_profile_url: `https://myfans.jp/creator_${Math.ceil(index / 4)}`,
    price_jpy: index % 3 === 0 ? null : 1000 + index,
    affiliate_reward_rate: 50,
    estimated_reward_jpy: 500,
    media_type: "video",
    affiliate_eligible: true,
    source_surface: "post_search",
    source_page_url: pageUrl(page),
    collected_at: `2026-09-${String(Math.min(page, 30)).padStart(2, "0")}T00:00:00.000Z`,
    parser_confidence: "HIGH"
  };
}

function pageSnapshot(page, options = {}) {
  const postsPerPage = options.posts_per_page ?? 20;
  const start = (page - 1) * postsPerPage + 1;
  const sourcePageUrl = options.source_page_url || pageUrl(page, options.query);
  const snapshot = {
    source_surface: "post_search",
    source_page_url: sourcePageUrl,
    collected_at: `2026-09-${String(Math.min(page, 30)).padStart(2, "0")}T00:00:00.000Z`,
    posts: Array.from({ length: postsPerPage }, (_, offset) => {
      const post = postFor(start + offset, page);
      post.source_page_url = sourcePageUrl;
      return post;
    }),
    creators: [],
    warnings: [],
    stop_reason: options.stop_reason || null
  };
  snapshot.fingerprint = core.fingerprintPage(snapshot);
  return snapshot;
}

function seedCatalog({ checkpointVersion = "0.3.1", visibleNext = false } = {}) {
  const snapshots = Array.from({ length: 5 }, (_, index) => pageSnapshot(index + 1));
  const raw = core.buildExport(snapshots, {
    collected_at: snapshots.at(-1).collected_at,
    stop_reason: "MAX_PAGE_LIMIT_REACHED"
  });
  const run = core.attachCollectionRunMetadata(raw, {
    run_id: "seed-pages-1-5",
    mode: "NEW",
    expected_scope_key: core.canonicalCollectionScope(pageUrl(1)).key,
    expected_start_page: 1,
    next_control: visibleNext
      ? { present: true, enabled: true, href: null }
      : { present: true, enabled: true, href: pageUrl(6) }
  });
  const catalog = core.mergeCumulativeCatalog(null, run).catalog;
  catalog.collector_version = checkpointVersion;
  catalog.checkpoint_summary.collector_version = checkpointVersion;
  return catalog;
}

function createMemoryStorage(initial = {}) {
  const data = clone(initial);
  let setCount = 0;
  return {
    data,
    get setCount() {
      return setCount;
    },
    async get(keys) {
      if (keys == null) return clone(data);
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(names.filter((key) => key in data).map((key) => [key, clone(data[key])]));
    },
    async set(update) {
      Object.assign(data, clone(update));
      setCount += 1;
    }
  };
}

function createHarness(options = {}) {
  const initialCatalog = options.catalog || null;
  const scope = core.canonicalCollectionScope(pageUrl(1));
  const storage = createMemoryStorage(initialCatalog ? {
    [durable.CATALOG_KEY]: { [scope.key]: initialCatalog }
  } : {});
  let now = Date.parse("2026-09-25T00:00:00.000Z");
  let currentPage = options.current_page || 1;
  let query = "sexual_orientation=woman";
  let tabExists = options.tab_exists !== false;
  let uuidCounter = 0;
  let navigationCount = 0;
  let prepareCount = 0;
  const collectCounts = new Map();
  const failures = new Map(Object.entries(options.failures || {}).map(([page, reason]) => [Number(page), reason]));
  const adapters = {
    storage,
    now: () => now,
    uuid: () => `nonce-${++uuidCounter}`,
    tab_exists: async () => tabExists,
    get_context: async () => core.collectionContextFromUrl(pageUrl(currentPage, query)),
    collect_page: async () => {
      const callIndex = collectCounts.get(currentPage) || 0;
      collectCounts.set(currentPage, callIndex + 1);
      const reason = failures.get(currentPage);
      if (reason) throw new Error(reason);
      const sequence = options.page_sequences?.[currentPage];
      if (sequence?.length) {
        const value = sequence[Math.min(callIndex, sequence.length - 1)];
        if (value === "PREVIOUS") {
          const stale = pageSnapshot(Math.max(1, currentPage - 1), {
            query,
            source_page_url: pageUrl(currentPage, query)
          });
          stale.fingerprint = core.fingerprintPage(stale);
          return stale;
        }
        if (typeof value === "number") {
          return pageSnapshot(currentPage, { query, posts_per_page: value });
        }
        return clone(value);
      }
      if (options.stale_fingerprint && currentPage > 1) {
        const stale = pageSnapshot(1, { query, source_page_url: pageUrl(currentPage, query) });
        stale.fingerprint = core.fingerprintPage(stale);
        return stale;
      }
      return pageSnapshot(currentPage, { query });
    },
    inspect_next: async () => ({
      present: currentPage < (options.end_page || 999),
      enabled: currentPage < (options.end_page || 999),
      href: currentPage < (options.end_page || 999) ? pageUrl(currentPage + 1, query) : null
    }),
    prepare_navigation: async (_tabId, expected) => {
      prepareCount += 1;
      if (options.prepare_error) throw new Error(options.prepare_error);
      const navigationExpected = currentPage < (options.end_page || 999);
      return {
        ok: true,
        navigation_expected: navigationExpected,
        from_page: currentPage,
        expected_next_page: navigationExpected ? currentPage + 1 : null,
        previous_fingerprint: expected.expected_fingerprint,
        next_control: {
          present: navigationExpected,
          enabled: navigationExpected,
          href: navigationExpected ? pageUrl(currentPage + 1, query) : null
        }
      };
    },
    navigate_now: async () => {
      navigationCount += 1;
      currentPage += options.navigation_delta || 1;
      if (options.channel_close_after_ack && navigationCount === 1) {
        throw new Error("A listener indicated an asynchronous response, but the message channel closed");
      }
      return { ok: true };
    },
    navigate_tab: async (_tabId, url) => {
      const context = core.collectionContextFromUrl(url);
      if (!context) throw new Error("POSITION_URL_INVALID");
      currentPage = context.page;
      navigationCount += 1;
    }
  };
  return {
    adapters,
    storage,
    scope,
    get currentPage() {
      return currentPage;
    },
    set currentPage(page) {
      currentPage = page;
    },
    set query(value) {
      query = value;
    },
    set tabExists(value) {
      tabExists = value;
    },
    advance(milliseconds) {
      now += milliseconds;
    },
    get navigationCount() {
      return navigationCount;
    },
    get prepareCount() {
      return prepareCount;
    },
    collectCount(page) {
      return collectCounts.get(page) || 0;
    }
  };
}

async function stepToTerminal(harness, operationId, options = {}) {
  const states = [];
  for (let step = 0; step < (options.max_steps || 100); step += 1) {
    const state = await durable.createDurableOrchestrator(harness.adapters).readState();
    if (state.active) states.push(state.active.state);
    if (state.active && ["COMPLETED", "FAILED", "CANCELLED", "PAUSED_REQUIRES_RECOVERY"].includes(state.active.state)) {
      return { operation: state.active, states };
    }
    await durable.createDurableOrchestrator(harness.adapters).driveOne(operationId);
    harness.advance(durable.READY_POLL_INTERVAL_MS);
  }
  throw new Error("TEST_OPERATION_DID_NOT_TERMINATE");
}

async function stepUntil(harness, operationId, predicate, options = {}) {
  for (let step = 0; step < (options.max_steps || 100); step += 1) {
    const state = await durable.createDurableOrchestrator(harness.adapters).readState();
    if (predicate(state.active)) return state.active;
    await durable.createDurableOrchestrator(harness.adapters).driveOne(operationId);
    harness.advance(durable.READY_POLL_INTERVAL_MS);
  }
  throw new Error("TEST_OPERATION_CONDITION_NOT_REACHED");
}

test("journal schema persists the requested durable operation contract", async () => {
  const harness = createHarness();
  const orchestrator = durable.createDurableOrchestrator(harness.adapters);
  await orchestrator.start({ operation_id: "journal-contract", mode: "NEW", tab_id: 7 });
  const operation = (await orchestrator.readState()).active;
  assert.equal(operation.schema_version, "myfans-background-operation-v1");
  for (const key of [
    "operation_id", "mode", "scope", "tab_id", "state", "stage", "started_at", "updated_at",
    "start_page", "expected_page", "last_confirmed_page", "pages_staged", "max_pages",
    "previous_fingerprint", "expected_next_evidence", "warnings", "failure_reason",
    "cancellation_state", "commit_state", "export_state", "staged_snapshots", "readiness"
  ]) assert.ok(key in operation, key);
  assert.equal(operation.max_pages, 5);
});

test("new collection survives popup absence and worker restart in every normal stage", async () => {
  const harness = createHarness();
  await durable.createDurableOrchestrator(harness.adapters).start({
    operation_id: "popup-closed-new",
    mode: "NEW",
    tab_id: 7
  });
  const terminal = await stepToTerminal(harness, "popup-closed-new");
  assert.equal(terminal.operation.state, "COMPLETED");
  for (const expected of [
    "STARTING", "COLLECTING_CURRENT_PAGE", "STAGING_PAGE", "PREPARING_NAVIGATION",
    "WAITING_FOR_NEW_DOCUMENT", "VALIDATING_NEW_DOCUMENT", "READY_TO_COMMIT", "COMMITTING"
  ]) assert.ok(terminal.states.includes(expected), expected);
  assert.equal(terminal.operation.pages_staged, 5);
  assert.equal(terminal.operation.result.cumulative_posts, 100);
  assert.equal(terminal.operation.result.run_count, 1);
  assert.equal(harness.navigationCount, 4);
});

test("legacy 0.2.x visible-next checkpoint resumes at page 6 and commits pages 6-10", async () => {
  const catalog = seedCatalog({ checkpointVersion: "0.2.0", visibleNext: true });
  const before = clone(catalog);
  const harness = createHarness({ catalog, current_page: 5 });
  const firstWorker = durable.createDurableOrchestrator(harness.adapters);
  await firstWorker.start({ operation_id: "resume-pages-6-10", mode: "RESUME", tab_id: 7 });
  // Popup closes here; a fresh service-worker instance owns all subsequent work.
  const terminal = await stepToTerminal(harness, "resume-pages-6-10");
  assert.equal(terminal.operation.state, "COMPLETED");
  assert.equal(terminal.operation.result.start_page, 6);
  assert.equal(terminal.operation.result.last_successfully_collected_page, 10);
  assert.equal(terminal.operation.result.cumulative_posts, 200);
  const saved = (await durable.createDurableOrchestrator(harness.adapters).readState()).catalogs[harness.scope.key];
  assert.equal(saved.run_count, 2);
  assert.equal(saved.checkpoint_summary.last_successfully_collected_page, 10);
  assert.equal(before.counts.posts, 100);
});

test("saved page-5 checkpoint remains resumable when the failed pilot left the tab on page 6", async () => {
  const catalog = seedCatalog({ checkpointVersion: "0.2.1", visibleNext: true });
  const harness = createHarness({ catalog, current_page: 6 });
  const orchestrator = durable.createDurableOrchestrator(harness.adapters);
  await orchestrator.start({ operation_id: "resume-tab-left-page-6", mode: "RESUME", tab_id: 7 });
  const terminal = await stepToTerminal(harness, "resume-tab-left-page-6");
  assert.equal(terminal.operation.state, "COMPLETED");
  assert.equal(terminal.operation.result.start_page, 6);
  assert.equal(terminal.operation.result.last_successfully_collected_page, 10);
  assert.equal(terminal.operation.result.cumulative_posts, 200);
});

test("a third background run resumes pages 11-15 without resetting cumulative state", async () => {
  const catalog = seedCatalog({ visibleNext: true });
  const harness = createHarness({ catalog, current_page: 5 });
  let orchestrator = durable.createDurableOrchestrator(harness.adapters);
  await orchestrator.start({ operation_id: "second-run-6-10", mode: "RESUME", tab_id: 7 });
  await stepToTerminal(harness, "second-run-6-10");
  orchestrator = durable.createDurableOrchestrator(harness.adapters);
  const claim = await orchestrator.claimExports("second-run-6-10");
  await orchestrator.markExportsDelivered("second-run-6-10", claim.claim_token);

  await orchestrator.start({ operation_id: "third-run-11-15", mode: "RESUME", tab_id: 7 });
  const terminal = await stepToTerminal(harness, "third-run-11-15");
  assert.equal(terminal.operation.result.start_page, 11);
  assert.equal(terminal.operation.result.last_successfully_collected_page, 15);
  assert.equal(terminal.operation.result.cumulative_posts, 300);
  assert.equal(terminal.operation.result.run_count, 3);
});

test("post-ACK channel close is recoverable for full-document navigation", async () => {
  const harness = createHarness({ channel_close_after_ack: true });
  const orchestrator = durable.createDurableOrchestrator(harness.adapters);
  await orchestrator.start({ operation_id: "expected-channel-close", mode: "NEW", tab_id: 7 });
  const terminal = await stepToTerminal(harness, "expected-channel-close");
  assert.equal(terminal.operation.state, "COMPLETED");
  assert.equal(terminal.operation.result.pages_collected, 5);
});

test("channel close before PREPARE ACK fails closed", async () => {
  const harness = createHarness({ prepare_error: "Could not establish connection. Receiving end does not exist." });
  const orchestrator = durable.createDurableOrchestrator(harness.adapters);
  await orchestrator.start({ operation_id: "before-ack-close", mode: "NEW", tab_id: 7 });
  const terminal = await stepToTerminal(harness, "before-ack-close");
  assert.equal(terminal.operation.state, "FAILED");
  assert.match(terminal.operation.failure_reason, /Receiving end does not exist/);
  assert.equal(terminal.operation.failure_stage, "PREPARING_NAVIGATION");
  assert.equal((await orchestrator.readState()).catalogs[harness.scope.key], undefined);
});

test("SPA-like navigation validates URL, rows, and changed fingerprint before staging", async () => {
  const harness = createHarness();
  const orchestrator = durable.createDurableOrchestrator(harness.adapters);
  await orchestrator.start({ operation_id: "spa-navigation", mode: "NEW", tab_id: 7 });
  const terminal = await stepToTerminal(harness, "spa-navigation");
  assert.equal(terminal.operation.state, "COMPLETED");
  assert.equal(new Set(terminal.operation.staged_snapshots.map((item) => item.fingerprint)).size, 5);
});

test("expected page waits through empty hydration and accepts only a settled 20-record snapshot", async () => {
  const catalog = seedCatalog({ visibleNext: true });
  const harness = createHarness({
    catalog,
    current_page: 5,
    page_sequences: { 6: [0, 20, 20] }
  });
  const orchestrator = durable.createDurableOrchestrator(harness.adapters);
  await orchestrator.start({ operation_id: "hydrate-zero-to-twenty", mode: "RESUME", tab_id: 7 });
  const terminal = await stepToTerminal(harness, "hydrate-zero-to-twenty");
  assert.equal(terminal.operation.state, "COMPLETED");
  assert.equal(terminal.operation.result.start_page, 6);
  assert.equal(terminal.operation.result.last_successfully_collected_page, 10);
  assert.ok(harness.collectCount(6) >= 3);
  const pageSix = terminal.operation.staged_snapshots.find((snapshot) => (
    core.collectionContextFromUrl(snapshot.source_page_url)?.page === 6
  ));
  assert.equal(pageSix.posts.length, 20);
});

test("partial hydration resets the settle candidate until the 20-record UUID set is stable", async () => {
  const catalog = seedCatalog({ visibleNext: true });
  const harness = createHarness({
    catalog,
    current_page: 5,
    page_sequences: { 6: [0, 8, 20, 20] }
  });
  const orchestrator = durable.createDurableOrchestrator(harness.adapters);
  await orchestrator.start({ operation_id: "hydrate-partial-to-stable", mode: "RESUME", tab_id: 7 });
  const terminal = await stepToTerminal(harness, "hydrate-partial-to-stable");
  assert.equal(terminal.operation.state, "COMPLETED");
  assert.ok(harness.collectCount(6) >= 4);
  const pageSix = terminal.operation.staged_snapshots.find((snapshot) => (
    core.collectionContextFromUrl(snapshot.source_page_url)?.page === 6
  ));
  assert.equal(pageSix.posts.length, 20);
});

test("a reachable catalog shell with permanent zero rows times out without changing formal state", async () => {
  const catalog = seedCatalog({ visibleNext: true });
  const before = clone(catalog);
  const harness = createHarness({
    catalog,
    current_page: 5,
    page_sequences: { 6: [0] }
  });
  const orchestrator = durable.createDurableOrchestrator(harness.adapters);
  await orchestrator.start({ operation_id: "catalog-shell-only", mode: "RESUME", tab_id: 7 });
  const terminal = await stepToTerminal(harness, "catalog-shell-only");
  assert.equal(terminal.operation.state, "FAILED");
  assert.equal(terminal.operation.failure_stage, "WAITING_FOR_NEW_DOCUMENT");
  assert.equal(terminal.operation.failure_reason, "CATALOG_ROWS_NOT_READY");
  assert.equal(terminal.operation.pages_staged, 0);
  assert.equal(terminal.operation.readiness.last_observed_record_count, 0);
  const saved = (await orchestrator.readState()).catalogs[harness.scope.key];
  assert.deepEqual(saved, before);
  assert.equal(saved.counts.posts, 100);
  assert.equal(saved.checkpoint_summary.last_successfully_collected_page, 5);
});

test("new URL with the previous page UUID fingerprint waits until deadline then fails closed", async () => {
  const harness = createHarness({
    page_sequences: { 2: ["PREVIOUS"] }
  });
  const orchestrator = durable.createDurableOrchestrator(harness.adapters);
  await orchestrator.start({ operation_id: "old-dom-new-url", mode: "NEW", tab_id: 7 });
  const terminal = await stepToTerminal(harness, "old-dom-new-url");
  assert.equal(terminal.operation.state, "FAILED");
  assert.equal(terminal.operation.failure_reason, "PAGE_FINGERPRINT_UNCHANGED");
  assert.equal(terminal.operation.readiness.saw_records, true);
  assert.equal(terminal.operation.readiness.saw_changed_fingerprint, false);
  assert.equal((await orchestrator.readState()).catalogs[harness.scope.key], undefined);
});

test("duplicate READY recovery calls share one readiness observation", async () => {
  const catalog = seedCatalog({ visibleNext: true });
  const harness = createHarness({
    catalog,
    current_page: 5,
    page_sequences: { 6: [0, 20, 20] }
  });
  const orchestrator = durable.createDurableOrchestrator(harness.adapters);
  await orchestrator.start({ operation_id: "duplicate-ready-hydration", mode: "RESUME", tab_id: 7 });
  await stepUntil(
    harness,
    "duplicate-ready-hydration",
    (operation) => operation?.readiness?.status === "WAITING_FOR_ROWS"
  );
  const before = harness.collectCount(6);
  const results = await Promise.all([
    orchestrator.recoverActive(7),
    orchestrator.recoverActive(7),
    orchestrator.recoverActive(7)
  ]);
  assert.equal(harness.collectCount(6), before + 1);
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[1], results[2]);
});

test("worker restart during hydration preserves the original deadline and resumes settling", async () => {
  const catalog = seedCatalog({ visibleNext: true });
  const harness = createHarness({
    catalog,
    current_page: 5,
    page_sequences: { 6: [0, 20, 20] }
  });
  let orchestrator = durable.createDurableOrchestrator(harness.adapters);
  await orchestrator.start({ operation_id: "restart-during-hydration", mode: "RESUME", tab_id: 7 });
  const empty = await stepUntil(
    harness,
    "restart-during-hydration",
    (operation) => operation?.readiness?.status === "WAITING_FOR_ROWS"
  );
  const originalStartedAt = empty.readiness.readiness_started_at;
  const originalDeadline = empty.readiness.readiness_deadline;

  orchestrator = durable.createDurableOrchestrator(harness.adapters);
  const candidate = await orchestrator.recoverActive(7);
  assert.equal(candidate.readiness.status, "SETTLING");
  assert.equal(candidate.readiness.readiness_started_at, originalStartedAt);
  assert.equal(candidate.readiness.readiness_deadline, originalDeadline);

  harness.advance(durable.READY_SETTLE_MS);
  orchestrator = durable.createDurableOrchestrator(harness.adapters);
  await orchestrator.recoverActive(7);
  const terminal = await stepToTerminal(harness, "restart-during-hydration");
  assert.equal(terminal.operation.state, "COMPLETED");
  assert.equal(terminal.operation.result.last_successfully_collected_page, 10);
});

test("worker restart cannot reset an expired hydration deadline", async () => {
  const catalog = seedCatalog({ visibleNext: true });
  const harness = createHarness({
    catalog,
    current_page: 5,
    page_sequences: { 6: [0] }
  });
  let orchestrator = durable.createDurableOrchestrator(harness.adapters);
  await orchestrator.start({ operation_id: "restart-after-deadline", mode: "RESUME", tab_id: 7 });
  const waiting = await stepUntil(
    harness,
    "restart-after-deadline",
    (operation) => operation?.readiness?.status === "WAITING_FOR_ROWS"
  );
  const remaining = Date.parse(waiting.readiness.readiness_deadline) - Date.parse(waiting.readiness.last_observed_at);
  harness.advance(remaining + 1);

  orchestrator = durable.createDurableOrchestrator(harness.adapters);
  const failed = await orchestrator.driveOne("restart-after-deadline");
  assert.equal(failed.state, "FAILED");
  assert.equal(failed.failure_reason, "CATALOG_ROWS_NOT_READY");
  assert.equal(failed.readiness.readiness_deadline, waiting.readiness.readiness_deadline);
  const saved = (await orchestrator.readState()).catalogs[harness.scope.key];
  assert.equal(saved.counts.posts, 100);
  assert.equal(saved.checkpoint_summary.last_successfully_collected_page, 5);
});

test("a preserved terminal FAILED journal does not block a fresh resume operation", async () => {
  const catalog = seedCatalog({ visibleNext: true });
  const harness = createHarness({ catalog, current_page: 5 });
  const failedBase = durable.makeOperation({
    operation_id: "preserved-failed-pilot",
    mode: "RESUME",
    scope: harness.scope,
    tab_id: 7,
    expected_page: 6,
    last_confirmed_page: 5,
    resume_plan: core.validateResumeCheckpoint(catalog.checkpoint_summary, harness.scope),
    base_catalog_hash: "preserved"
  }, harness.adapters);
  const failed = durable.transition(failedBase, durable.OPERATION_STATES.FAILED, {
    failure_reason: "NO_CATALOG_RECORDS_DETECTED",
    failure_stage: durable.OPERATION_STATES.VALIDATING_NEW_DOCUMENT,
    completion_state: "INTERRUPTED"
  }, harness.adapters);
  await harness.storage.set({ [durable.ACTIVE_OPERATION_KEY]: failed });

  const orchestrator = durable.createDurableOrchestrator(harness.adapters);
  const started = await orchestrator.start({ operation_id: "fresh-after-failed", mode: "RESUME", tab_id: 7 });
  assert.equal(started.state, "STARTING");
  assert.equal(started.operation_id, "fresh-after-failed");
  const state = await orchestrator.readState();
  assert.equal(state.last.operation_id, "preserved-failed-pilot");
  assert.equal(state.catalogs[harness.scope.key].counts.posts, 100);
});

test("unexpected page and unchanged fingerprint fail closed before cumulative commit", async () => {
  const mismatchHarness = createHarness({ navigation_delta: 2 });
  const mismatchWorker = durable.createDurableOrchestrator(mismatchHarness.adapters);
  await mismatchWorker.start({ operation_id: "page-mismatch", mode: "NEW", tab_id: 7 });
  const mismatch = await stepToTerminal(mismatchHarness, "page-mismatch");
  assert.equal(mismatch.operation.state, "PAUSED_REQUIRES_RECOVERY");
  assert.equal(mismatch.operation.failure_reason, "EXPECTED_PAGE_MISMATCH");
  assert.equal((await mismatchWorker.readState()).catalogs[mismatchHarness.scope.key], undefined);

  const staleHarness = createHarness({ stale_fingerprint: true });
  const staleWorker = durable.createDurableOrchestrator(staleHarness.adapters);
  await staleWorker.start({ operation_id: "stale-fingerprint", mode: "NEW", tab_id: 7 });
  const stale = await stepToTerminal(staleHarness, "stale-fingerprint");
  assert.equal(stale.operation.state, "FAILED");
  assert.equal(stale.operation.failure_reason, "PAGE_FINGERPRINT_UNCHANGED");
  assert.equal((await staleWorker.readState()).catalogs[staleHarness.scope.key], undefined);
});

test("restart after a staged snapshot does not append the same page twice", async () => {
  const harness = createHarness();
  const orchestrator = durable.createDurableOrchestrator(harness.adapters);
  await orchestrator.start({ operation_id: "restart-after-stage", mode: "NEW", tab_id: 7 });
  await orchestrator.driveOne("restart-after-stage");
  await orchestrator.driveOne("restart-after-stage");
  const stagedState = await orchestrator.readState();
  const staged = durable.stageSnapshot(
    stagedState.active,
    stagedState.active.pending_snapshot,
    harness.adapters
  ).operation;
  await harness.storage.set({ [durable.ACTIVE_OPERATION_KEY]: staged });

  const restarted = durable.createDurableOrchestrator(harness.adapters);
  await restarted.driveOne("restart-after-stage");
  const recovered = (await restarted.readState()).active;
  assert.equal(recovered.pages_staged, 1);
  assert.equal(recovered.staged_snapshots.length, 1);
  assert.equal(recovered.state, "PREPARING_NAVIGATION");
});

test("scope mismatch and missing tab pause without touching the formal catalog", async () => {
  const catalog = seedCatalog({ visibleNext: true });
  const scopeHarness = createHarness({ catalog, current_page: 5 });
  const scopeWorker = durable.createDurableOrchestrator(scopeHarness.adapters);
  await scopeWorker.start({ operation_id: "scope-pause", mode: "RESUME", tab_id: 7 });
  scopeHarness.query = "sexual_orientation=man";
  const scopeResult = await scopeWorker.driveOne("scope-pause");
  assert.equal(scopeResult.state, "PAUSED_REQUIRES_RECOVERY");
  assert.equal((await scopeWorker.readState()).catalogs[scopeHarness.scope.key].counts.posts, 100);

  const tabHarness = createHarness({ catalog, current_page: 5 });
  const tabWorker = durable.createDurableOrchestrator(tabHarness.adapters);
  await tabWorker.start({ operation_id: "tab-pause", mode: "RESUME", tab_id: 7 });
  tabHarness.tabExists = false;
  const tabResult = await tabWorker.driveOne("tab-pause");
  assert.equal(tabResult.state, "PAUSED_REQUIRES_RECOVERY");
  assert.equal((await tabWorker.readState()).catalogs[tabHarness.scope.key].counts.posts, 100);
});

test("page 8 failure preserves the old 100-post checkpoint and discards partial staging", async () => {
  const catalog = seedCatalog({ visibleNext: true });
  const before = clone(catalog);
  const harness = createHarness({ catalog, current_page: 5, failures: { 8: "LOGIN_REDIRECT" } });
  const orchestrator = durable.createDurableOrchestrator(harness.adapters);
  await orchestrator.start({ operation_id: "fail-on-page-8", mode: "RESUME", tab_id: 7 });
  const terminal = await stepToTerminal(harness, "fail-on-page-8");
  assert.equal(terminal.operation.state, "FAILED");
  assert.equal(terminal.operation.pages_staged, 2);
  const after = (await orchestrator.readState()).catalogs[harness.scope.key];
  assert.deepEqual(after, before);
  assert.equal(after.counts.posts, 100);
  assert.equal(after.checkpoint_summary.last_successfully_collected_page, 5);
});

test("cancel preserves old cumulative and checkpoint", async () => {
  const catalog = seedCatalog({ visibleNext: true });
  const harness = createHarness({ catalog, current_page: 5 });
  const orchestrator = durable.createDurableOrchestrator(harness.adapters);
  await orchestrator.start({ operation_id: "cancel-resume", mode: "RESUME", tab_id: 7 });
  await orchestrator.driveOne("cancel-resume");
  const cancelled = await orchestrator.cancel("cancel-resume");
  assert.equal(cancelled.state, "CANCELLED");
  const saved = (await orchestrator.readState()).catalogs[harness.scope.key];
  assert.equal(saved.counts.posts, 100);
  assert.equal(saved.checkpoint_summary.last_successfully_collected_page, 5);
});

test("duplicate operation is rejected while an operation is active", async () => {
  const harness = createHarness();
  const orchestrator = durable.createDurableOrchestrator(harness.adapters);
  await orchestrator.start({ operation_id: "first", mode: "NEW", tab_id: 7 });
  await assert.rejects(
    orchestrator.start({ operation_id: "second", mode: "NEW", tab_id: 7 }),
    /DUPLICATE_OPERATION/
  );
});

test("duplicate READY drives share one in-flight promise", async () => {
  const harness = createHarness();
  const orchestrator = durable.createDurableOrchestrator(harness.adapters);
  await orchestrator.start({ operation_id: "duplicate-ready", mode: "NEW", tab_id: 7 });
  const first = orchestrator.drive("duplicate-ready");
  const second = orchestrator.drive("duplicate-ready");
  const [left, right] = await Promise.all([first, second]);
  assert.deepEqual(left, right);
  assert.ok(harness.navigationCount <= 1);
});

test("successful commit, run count, checkpoint advance, and export generation occur once", async () => {
  const catalog = seedCatalog({ visibleNext: true });
  const harness = createHarness({ catalog, current_page: 5 });
  let orchestrator = durable.createDurableOrchestrator(harness.adapters);
  await orchestrator.start({ operation_id: "commit-once", mode: "RESUME", tab_id: 7 });
  const terminal = await stepToTerminal(harness, "commit-once");
  assert.equal(terminal.operation.state, "COMPLETED");
  orchestrator = durable.createDurableOrchestrator(harness.adapters);
  const recovered = await orchestrator.recoverActive(7);
  assert.equal(recovered.state, "COMPLETED");
  const state = await orchestrator.readState();
  assert.equal(state.catalogs[harness.scope.key].run_count, 2);
  assert.equal(state.catalogs[harness.scope.key].checkpoint_summary.last_successfully_collected_page, 10);
  assert.equal(state.active.export_state, "GENERATED");

  const claim = await orchestrator.claimExports("commit-once");
  const retry = await orchestrator.claimExports("commit-once");
  assert.equal(claim.claimed, true);
  assert.equal(retry.claimed, true);
  assert.equal(retry.claim_token, claim.claim_token);
  assert.equal(retry.artifacts.cumulative.run_count, 2);
  await orchestrator.markExportsDelivered("commit-once", claim.claim_token);
  const unavailable = await orchestrator.claimExports("commit-once");
  assert.equal(unavailable.claimed, false);
  assert.equal(unavailable.export_state, "DELIVERED");
});

test("repeated resume data remains UUID-deduplicated and snapshot absence never deletes", async () => {
  const catalog = seedCatalog({ visibleNext: true });
  const harness = createHarness({ catalog, current_page: 5 });
  const orchestrator = durable.createDurableOrchestrator(harness.adapters);
  await orchestrator.start({ operation_id: "dedupe-resume", mode: "RESUME", tab_id: 7 });
  await stepToTerminal(harness, "dedupe-resume");
  const saved = (await orchestrator.readState()).catalogs[harness.scope.key];
  assert.equal(saved.counts.posts, 200);
  assert.equal(new Set(saved.posts.map((post) => post.post_uuid)).size, 200);
  assert.equal(saved.merge_summary.deletion_candidates, 0);
});
