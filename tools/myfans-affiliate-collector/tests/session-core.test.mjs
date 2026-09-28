import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dryRunCatalogImport } from "../importer/dry-run-importer.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(testDir, "..");
const sources = await Promise.all([
  "collector-core.js",
  "export-artifacts.js",
  "download-delivery.js",
  "orchestrator-core.js",
  "session-core.js"
].map((name) => readFile(path.join(extensionRoot, "src", name), "utf8")));
const sandbox = { URL, console, crypto: webcrypto, TextEncoder, btoa };
vm.createContext(sandbox);
for (const [index, source] of sources.entries()) vm.runInContext(source, sandbox, { filename: `source-${index}.js` });
const collector = sandbox.MyFansCollectorCore;
const durable = sandbox.MyFansOrchestratorCore;
const sessions = sandbox.MyFansAutoSessionCore;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function pageUrl(page) {
  return `https://www.affiliate.myfans.jp/affiliates/search?sexual_orientation=woman&page=${page}`;
}

function uuidFor(index) {
  return `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function postFor(index, page) {
  const uuid = uuidFor(index);
  const creatorIndex = Math.ceil(index / 4);
  const price = index % 7 === 0 ? null : 1200 + index;
  return {
    post_uuid: uuid,
    post_public_url: `https://myfans.jp/posts/${uuid}`,
    title: `Synthetic autonomous post ${index}`,
    creator_name: `Creator ${creatorIndex}`,
    creator_username: `creator_${creatorIndex}`,
    creator_profile_url: `https://myfans.jp/creator_${creatorIndex}`,
    price_jpy: price,
    affiliate_reward_rate: 50,
    estimated_reward_jpy: price == null ? null : 600,
    media_type: index % 11 === 0 ? "unknown" : "video",
    affiliate_eligible: true,
    source_surface: "post_search",
    source_page_url: pageUrl(page),
    collected_at: "2026-09-28T00:00:00.000Z",
    parser_confidence: "HIGH"
  };
}

function pageSnapshot(page, count = 20, options = {}) {
  const start = page * 1000;
  const posts = Array.from({ length: count }, (_, offset) => postFor(start + offset, page));
  if (options.duplicate_uuid || options.changed_duplicate) {
    posts[0] = clone(options.duplicate_post);
    posts[0].source_page_url = pageUrl(page);
    posts[0].collected_at = "2026-09-28T00:00:00.000Z";
    if (options.changed_duplicate) posts[0].title = "Observed changed allowed title";
  }
  const snapshot = {
    source_surface: "post_search",
    source_page_url: pageUrl(page),
    collected_at: "2026-09-28T00:00:00.000Z",
    posts,
    creators: [],
    warnings: [],
    stop_reason: null
  };
  snapshot.fingerprint = collector.fingerprintPage(snapshot);
  return snapshot;
}

function runBundle(pages, runId, mode) {
  const raw = collector.buildExport(pages, {
    collected_at: "2026-09-28T00:00:00.000Z",
    stop_reason: "MAX_PAGE_LIMIT_REACHED"
  });
  return collector.attachCollectionRunMetadata(raw, {
    run_id: runId,
    mode,
    expected_scope_key: collector.canonicalCollectionScope(pageUrl(1)).key,
    expected_start_page: pages[0] && Number(new URL(pages[0].source_page_url).searchParams.get("page")),
    next_control: { present: true, enabled: true, href: pageUrl(Number(new URL(pages.at(-1).source_page_url).searchParams.get("page")) + 1) }
  });
}

function seed199Catalog() {
  const pages1to5 = Array.from({ length: 5 }, (_, index) => pageSnapshot(index + 1));
  const first = collector.mergeCumulativeCatalog(null, runBundle(pages1to5, "seed-1-5", "NEW")).catalog;
  const pages6to10 = Array.from({ length: 5 }, (_, index) => pageSnapshot(index + 6));
  pages6to10[0].posts[0] = clone(pages1to5[4].posts.at(-1));
  pages6to10[0].posts[0].source_page_url = pageUrl(6);
  pages6to10[0].fingerprint = collector.fingerprintPage(pages6to10[0]);
  const second = collector.mergeCumulativeCatalog(first, runBundle(pages6to10, "seed-6-10", "RESUME")).catalog;
  assert.equal(second.counts.posts, 199);
  assert.equal(second.checkpoint_summary.last_successfully_collected_page, 10);
  assert.equal(second.run_count, 2);
  return second;
}

function createMemoryStorage(initial = {}) {
  const data = clone(initial);
  return {
    data,
    async get(keys) {
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(names.filter((key) => key in data).map((key) => [key, clone(data[key])]));
    },
    async set(update) {
      Object.assign(data, clone(update));
    }
  };
}

function createHarness(options = {}) {
  const scope = collector.canonicalCollectionScope(pageUrl(1));
  const baseline = seed199Catalog();
  const storage = createMemoryStorage({ [durable.CATALOG_KEY]: { [scope.key]: baseline } });
  let now = Date.parse("2026-09-28T01:00:00.000Z");
  let currentPage = 10;
  let uuidCounter = 0;
  let nextDownloadId = 8000;
  const failures = new Map(Object.entries(options.failures || {}).map(([page, reason]) => [Number(page), reason]));
  const collectCount = new Map();
  const downloadItems = new Map();
  const downloadRequests = [];
  const duplicatePost = baseline.posts[0];
  const adapters = {
    storage,
    now: () => now,
    uuid: () => `test-${++uuidCounter}`,
    tab_exists: async () => true,
    get_context: async () => collector.collectionContextFromUrl(pageUrl(currentPage)),
    collect_page: async () => {
      if (failures.has(currentPage)) throw new Error(failures.get(currentPage));
      const call = collectCount.get(currentPage) || 0;
      collectCount.set(currentPage, call + 1);
      const hydration = options.hydration?.[currentPage];
      const count = hydration ? hydration[Math.min(call, hydration.length - 1)] : 20;
      return pageSnapshot(currentPage, count, {
        duplicate_uuid: options.duplicate_page === currentPage,
        changed_duplicate: options.changed_duplicate_page === currentPage,
        duplicate_post: duplicatePost
      });
    },
    inspect_next: async () => ({
      present: currentPage < (options.end_page || 999),
      enabled: currentPage < (options.end_page || 999),
      href: currentPage < (options.end_page || 999) ? pageUrl(currentPage + 1) : null
    }),
    prepare_navigation: async (_tabId, expected) => ({
      ok: true,
      navigation_expected: currentPage < (options.end_page || 999),
      from_page: currentPage,
      expected_next_page: currentPage < (options.end_page || 999) ? currentPage + 1 : null,
      previous_fingerprint: expected.expected_fingerprint,
      next_control: {
        present: currentPage < (options.end_page || 999),
        enabled: currentPage < (options.end_page || 999),
        href: currentPage < (options.end_page || 999) ? pageUrl(currentPage + 1) : null
      }
    }),
    navigate_now: async () => {
      currentPage += 1;
      return { ok: true };
    },
    navigate_tab: async (_tabId, url) => {
      currentPage = Number(new URL(url).searchParams.get("page"));
    },
    download_artifact: async (artifact) => {
      const id = nextDownloadId++;
      downloadRequests.push(clone(artifact));
      downloadItems.set(id, {
        id,
        state: "in_progress",
        filename: `/Downloads/${artifact.filename}`,
        fileSize: -1,
        totalBytes: artifact.byte_length,
        bytesReceived: 0,
        exists: true
      });
      return id;
    },
    search_download: async (id) => clone(downloadItems.get(id) || null)
  };

  let chunk = durable.createDurableOrchestrator(adapters);
  let auto = sessions.createAutoSessionOrchestrator({
    storage,
    now: adapters.now,
    uuid: adapters.uuid,
    get_context: adapters.get_context,
    chunk_orchestrator: chunk
  });

  function restartWorker() {
    chunk = durable.createDurableOrchestrator(adapters);
    auto = sessions.createAutoSessionOrchestrator({
      storage,
      now: adapters.now,
      uuid: adapters.uuid,
      get_context: adapters.get_context,
      chunk_orchestrator: chunk
    });
  }

  async function settleDownloads() {
    const state = await chunk.readState();
    const artifacts = state.active?.generated_export?.artifacts || {};
    const downloading = Object.values(artifacts).find((artifact) => artifact?.delivery_state === "DOWNLOADING");
    if (!downloading) return false;
    const item = downloadItems.get(downloading.download_id);
    Object.assign(item, {
      state: "complete",
      filename: `/Downloads/${downloading.filename}`,
      fileSize: downloading.byte_length,
      totalBytes: downloading.byte_length,
      bytesReceived: downloading.byte_length,
      exists: true
    });
    await chunk.handleDownloadChanged({ id: downloading.download_id, state: { current: "complete" } });
    return true;
  }

  async function runToTerminal({ restart_every = 0 } = {}) {
    for (let iteration = 0; iteration < 3000; iteration += 1) {
      if (restart_every && iteration > 0 && iteration % restart_every === 0) restartWorker();
      await auto.recover(7);
      await settleDownloads();
      now += 300;
      const status = (await auto.getStatus()).active;
      if (status && status.session_state !== "RUNNING") return status;
    }
    throw new Error("SESSION_TEST_TIMEOUT");
  }

  return {
    adapters,
    baseline,
    downloadItems,
    downloadRequests,
    failures,
    get auto() { return auto; },
    get chunk() { return chunk; },
    get currentPage() { return currentPage; },
    restartWorker,
    runToTerminal,
    storage
  };
}

test("collector 0.5.0 keeps five pages as an internal chunk and defaults sessions to 50 pages", () => {
  assert.equal(collector.COLLECTOR_VERSION, "0.5.0");
  assert.equal(collector.MAX_RUN_PAGES, 5);
  assert.equal(sessions.DEFAULT_PAGE_LIMIT, 50);
  assert.deepEqual([...sessions.ALLOWED_PAGE_LIMITS], [25, 50, 100]);
});

test("one action chains ten five-page chunks from checkpoint 10 through page 60", async () => {
  const fixture = createHarness({
    hydration: { 11: [0, 8, 20, 20] },
    duplicate_page: 16,
    changed_duplicate_page: 17
  });
  await fixture.auto.start({ session_id: "auto-realistic", tab_id: 7, configured_page_limit: 50 });
  const completed = await fixture.runToTerminal({ restart_every: 17 });
  assert.equal(completed.session_state, "COMPLETED");
  assert.equal(completed.pages_completed, 50);
  assert.equal(completed.chunks_completed, 10);
  assert.equal(completed.start_checkpoint, 10);
  assert.equal(completed.current_checkpoint, 60);
  assert.equal(completed.stop_reason, "SESSION_PAGE_LIMIT_REACHED");
  assert.equal(completed.incremental_sync.status, "DB_SYNC_READY");
  assert.equal(completed.incremental_sync.counts.posts.UPDATE_NEEDED, 1);
  assert.equal(completed.incremental_sync.deletes, 0);
  assert.equal(completed.incremental_sync.unpublishes, 0);
  assert.equal(fixture.downloadRequests.length, 2);
  assert.deepEqual(fixture.downloadRequests.map((artifact) => artifact.artifact_type), ["RUN", "CUMULATIVE"]);
  const summary = JSON.parse(fixture.downloadRequests[0].serialized_text);
  const cumulative = JSON.parse(fixture.downloadRequests[1].serialized_text);
  assert.equal(summary.auto_collection.chunks_completed, 10);
  assert.equal(summary.auto_collection.pages_completed, 50);
  assert.equal(summary.incremental_sync.status, "DB_SYNC_READY");
  assert.equal(cumulative.checkpoint_summary.last_successfully_collected_page, 60);
  assert.equal(cumulative.run_count, 12);
  assert.deepEqual(cumulative.incremental_sync, summary.incremental_sync);
  assert.equal(new Set(cumulative.posts.map((post) => post.post_uuid)).size, cumulative.posts.length);
  const importerReport = dryRunCatalogImport(cumulative);
  assert.equal(importerReport.status, "PASS", JSON.stringify(importerReport.rejection_reasons));
  assert.equal(importerReport.counts.accepted, cumulative.posts.length);
  assert.equal(importerReport.db_query_count, 0);
  assert.equal(importerReport.db_write_count, 0);
  await fixture.auto.recover(7);
  await fixture.auto.recover(7);
  assert.equal(fixture.downloadRequests.length, 2);
  const finalState = await fixture.chunk.readState();
  const persisted = Object.values(finalState.catalogs)[0];
  assert.equal(persisted.run_count, 12);
  assert.equal("serialized_text" in finalState.active.generated_export.artifacts.run, false);
  assert.equal("serialized_text" in finalState.active.generated_export.artifacts.cumulative, false);
  assert.equal(finalState.active.generated_export.artifacts.run.payload_source, "AUTO_SESSION_SUMMARY");
  assert.equal(finalState.active.generated_export.artifacts.cumulative.payload_source, "FORMAL_CUMULATIVE_CATALOG");
});

test("popup-independent status and worker restarts recover the same running session", async () => {
  const fixture = createHarness({ hydration: { 11: [0, 20, 20] }, end_page: 15 });
  await fixture.auto.start({ session_id: "auto-restart", tab_id: 7, configured_page_limit: 25 });
  await fixture.auto.recover(7);
  const before = (await fixture.auto.getStatus()).active;
  fixture.restartWorker();
  const restored = (await fixture.auto.getStatus()).active;
  assert.equal(restored.session_id, before.session_id);
  assert.equal(restored.session_state, "RUNNING");
  const completed = await fixture.runToTerminal({ restart_every: 3 });
  assert.equal(completed.session_state, "COMPLETED");
  assert.equal(completed.end_of_catalog_detected, true);
  assert.equal(completed.current_checkpoint, 15);
  assert.equal(fixture.downloadRequests.length, 2);
});

test("worker restart after journaling a chunk ID but before chunk creation starts it idempotently", async () => {
  const fixture = createHarness({ end_page: 15 });
  await fixture.auto.start({ session_id: "auto-boundary-restart", tab_id: 7, configured_page_limit: 25 });
  const journal = fixture.storage.data[sessions.ACTIVE_SESSION_KEY];
  journal.current_chunk_operation_id = "auto-boundary-restart:chunk:1";
  journal.current_chunk_number = 1;
  journal.stage = sessions.SESSION_STAGES.STARTING_CHUNK;
  journal.revision += 1;
  fixture.storage.data[sessions.ACTIVE_SESSION_KEY] = clone(journal);
  fixture.restartWorker();
  const completed = await fixture.runToTerminal({ restart_every: 5 });
  assert.equal(completed.session_state, "COMPLETED");
  assert.equal(completed.chunks_completed, 1);
  assert.equal(completed.current_checkpoint, 15);
  assert.equal(fixture.downloadRequests.length, 2);
});

test("a first-chunk failure preserves the formal 199-post page-10 baseline", async () => {
  const fixture = createHarness({ failures: { 13: "ANTI_BOT_DETECTED" }, end_page: 15 });
  await fixture.auto.start({ session_id: "auto-failure", tab_id: 7, configured_page_limit: 50 });
  const stopped = await fixture.runToTerminal();
  assert.equal(stopped.session_state, "PAUSED");
  assert.equal(stopped.current_checkpoint, 10);
  assert.equal(stopped.chunks_completed, 0);
  const state = await fixture.chunk.readState();
  const catalog = Object.values(state.catalogs)[0];
  assert.equal(catalog.counts.posts, 199);
  assert.equal(catalog.checkpoint_summary.last_successfully_collected_page, 10);
  assert.equal(catalog.run_count, 2);
  assert.equal(fixture.downloadRequests.length, 0);

  fixture.failures.delete(13);
  await fixture.auto.start({ session_id: "auto-recovery", tab_id: 7, configured_page_limit: 25 });
  const recovered = await fixture.runToTerminal();
  assert.equal(recovered.session_state, "COMPLETED");
  assert.equal(recovered.start_checkpoint, 10);
  assert.equal(recovered.current_checkpoint, 15);
  assert.equal(recovered.chunks_completed, 1);
});

test("failure in a later chunk retains only the prior committed chunk", async () => {
  const fixture = createHarness({ failures: { 18: "UNEXPECTED_MODAL" } });
  await fixture.auto.start({ session_id: "auto-later-failure", tab_id: 7, configured_page_limit: 50 });
  const stopped = await fixture.runToTerminal();
  assert.equal(stopped.session_state, "PAUSED");
  assert.equal(stopped.current_checkpoint, 15);
  assert.equal(stopped.chunks_completed, 1);
  assert.equal(stopped.pages_completed, 5);
  const state = await fixture.chunk.readState();
  const catalog = Object.values(state.catalogs)[0];
  assert.equal(catalog.checkpoint_summary.last_successfully_collected_page, 15);
  assert.equal(catalog.run_count, 3);
  assert.equal(fixture.downloadRequests.length, 0);
});

test("catalog end after settling next-control absence completes early and exports once", async () => {
  const fixture = createHarness({ end_page: 17 });
  await fixture.auto.start({ session_id: "auto-catalog-end", tab_id: 7, configured_page_limit: 50 });
  const completed = await fixture.runToTerminal();
  assert.equal(completed.session_state, "COMPLETED");
  assert.equal(completed.pages_completed, 7);
  assert.equal(completed.chunks_completed, 2);
  assert.equal(completed.current_checkpoint, 17);
  assert.equal(completed.end_of_catalog_detected, true);
  assert.equal(completed.stop_reason, "CATALOG_COMPLETE");
  assert.equal(fixture.downloadRequests.length, 2);
});

test("duplicate auto-session start is rejected while one is running", async () => {
  const fixture = createHarness();
  await fixture.auto.start({ session_id: "auto-one", tab_id: 7, configured_page_limit: 50 });
  await assert.rejects(
    fixture.auto.start({ session_id: "auto-two", tab_id: 7, configured_page_limit: 50 }),
    /DUPLICATE_AUTO_SESSION/
  );
});

test("session cancellation preserves the last formal checkpoint and produces no download", async () => {
  const fixture = createHarness({ hydration: { 11: [0, 0, 20, 20] } });
  const started = await fixture.auto.start({ session_id: "auto-cancel", tab_id: 7, configured_page_limit: 50 });
  await fixture.auto.recover(7);
  const cancelled = await fixture.auto.cancel(started.session_id);
  assert.equal(cancelled.session_state, "CANCELLED");
  const state = await fixture.chunk.readState();
  const catalog = Object.values(state.catalogs)[0];
  assert.equal(catalog.counts.posts, 199);
  assert.equal(catalog.checkpoint_summary.last_successfully_collected_page, 10);
  assert.equal(catalog.run_count, 2);
  assert.equal(fixture.downloadRequests.length, 0);
});

test("incremental compact baseline classifies new, identical, update, and conflict without deletes", () => {
  const baselineCatalog = seed199Catalog();
  const baseline = collector.buildIncrementalBaseline(baselineCatalog);
  const current = clone(baselineCatalog);
  const identical = current.posts[0].post_uuid;
  const updated = current.posts[1].post_uuid;
  current.posts[1].title = "Changed allowed title";
  const added = postFor(999999, 11);
  current.posts.push(added);
  const conflict = current.posts[2].post_uuid;
  current.posts[2].post_public_url = `https://myfans.jp/posts/${uuidFor(888888)}`;
  const result = collector.classifyIncrementalSelection(current, baseline, {
    post_uuids: [identical, updated, added.post_uuid, conflict],
    creator_keys: []
  });
  assert.equal(result.counts.posts.EXISTING_IDENTICAL, 1);
  assert.equal(result.counts.posts.UPDATE_NEEDED, 1);
  assert.equal(result.counts.posts.NEW, 1);
  assert.equal(result.counts.posts.CONFLICT, 1);
  assert.equal(result.deletes, 0);
  assert.equal(result.unpublishes, 0);
  assert.equal(result.snapshot_absence_causes_deletion, false);
  assert.equal(result.status, "CONFLICT");
});
