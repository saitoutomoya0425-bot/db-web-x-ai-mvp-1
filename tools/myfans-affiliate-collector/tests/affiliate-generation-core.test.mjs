import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const sandbox = { crypto: webcrypto, TextEncoder, URL };
vm.createContext(sandbox);
for (const file of ["export-artifacts.js", "affiliate-generation-core.js"]) {
  vm.runInContext(await readFile(path.resolve(testDir, `../src/${file}`), "utf8"), sandbox, { filename: file });
}
const core = sandbox.MyFansAffiliateGenerationCore;

function post(index, overrides = {}) {
  const postUuid = `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  return {
    post_uuid: postUuid,
    post_public_url: `https://myfans.jp/posts/${postUuid}`,
    affiliate_eligible: true,
    ...overrides,
  };
}

function currentPage(posts, overrides = {}) {
  return {
    source_surface: "post_search",
    source_page_url: "https://www.affiliate.myfans.jp/affiliates/search/genres/f-beautiful-woman/result?genre_name=%E7%BE%8E%E5%A5%B3&sexual_orientation=woman&page=60",
    fingerprint: "page-60-fingerprint",
    posts,
    creators: [],
    warnings: [],
    stop_reason: null,
    ...overrides,
  };
}

function fakeStorage(initial = {}) {
  let state = structuredClone(initial);
  return {
    async get(keys) {
      return Object.fromEntries((keys || []).filter((key) => key in state).map((key) => [key, structuredClone(state[key])]));
    },
    async set(values) { state = { ...state, ...structuredClone(values) }; },
    dump() { return structuredClone(state); },
  };
}

function harness(options = {}) {
  const storage = fakeStorage(options.storage);
  let now = Date.parse("2026-09-29T00:00:00.000Z");
  const dispatches = [];
  const schedules = [];
  const adapters = {
    storage,
    now: () => now,
    uuid: () => `nonce-${dispatches.length + 1}`,
    get_catalog: async () => ({
      scope_key: "scope:test",
      catalog: options.catalog || { posts: [post(1), post(2), post(3), post(4)] },
    }),
    get_current_page: async () => ({
      scope_key: options.current_scope_key || "scope:test",
      page: 60,
      snapshot: options.current_page || currentPage([post(1), post(2), post(3), post(4)]),
    }),
    prepare_target: async () => ({ ready: true }),
    dispatch_generation: async (_tabId, request) => { dispatches.push(request); return { accepted: true }; },
    inspect_result: async () => ({ visible_urls: [], visible_text: "" }),
    schedule_recovery: async (sessionId, delayMs) => { schedules.push({ sessionId, delayMs }); },
    commit_result: async (_previous, next) => {
      await storage.set({ [core.ACTIVE_SESSION_KEY]: next });
      return next;
    },
  };
  return { adapters, storage, dispatches, schedules, advance(ms) { now += ms; } };
}

test("affiliate URL validation permits only exact HTTPS official host without credentials", () => {
  assert.equal(core.parseAffiliateUrl("https://link.affiliate.myfans.jp/observed/path"), "https://link.affiliate.myfans.jp/observed/path");
  for (const value of [
    "http://link.affiliate.myfans.jp/path",
    "https://user:pass@link.affiliate.myfans.jp/path",
    "https://link.affiliate.myfans.jp.evil.example/path",
    "javascript:alert(1)",
    "data:text/plain,test",
  ]) assert.equal(core.parseAffiliateUrl(value), null);
});

test("pilot freezes three eligible/MISSING targets from the current validated page in DOM order", async () => {
  const catalog = { posts: [
    post(4), post(3), post(2), post(1),
    post(5, { affiliate_eligible: false }),
    post(6, { displayed_affiliate_url: "https://link.affiliate.myfans.jp/existing" }),
    post(7, { post_public_url: "https://example.test/post" }),
  ] };
  const page = currentPage([post(4), post(2), post(1), post(3)]);
  const frozen = await core.freezePilotTargets(catalog, page);
  assert.equal(frozen.pilot_target_count, 3);
  assert.equal(frozen.eligible_target_count, 4);
  assert.equal(frozen.current_page_post_count, 4);
  assert.equal(frozen.current_page_candidate_count, 4);
  assert.deepEqual([...frozen.targets].map((target) => target.post_uuid), [post(4).post_uuid, post(2).post_uuid, post(1).post_uuid]);
  await assert.rejects(core.freezePilotTargets(catalog, page, { expected_target_hash: "sha256:wrong" }), /ATTESTATION_MISMATCH/);
  await assert.rejects(core.freezePilotTargets(catalog, page, { expected_eligible_count: 1194 }), /TARGET_COUNT_MISMATCH/);
});

test("arbitrary cumulative targets absent from page 60 cannot be frozen or clicked", async () => {
  const catalog = { posts: [post(1), post(2), post(3), post(60), post(61)] };
  const page = currentPage([post(60), post(61)]);
  await assert.rejects(core.freezePilotTargets(catalog, page), /PILOT_TARGETS_INSUFFICIENT/);
  assert.deepEqual(
    [...core.selectCurrentPageTargets(catalog, page, { max_targets: 3 }).targets].map((target) => target.post_uuid),
    [post(60).post_uuid, post(61).post_uuid],
  );
});

test("page-60 style twenty-card fixture selects exactly three and makes a fourth unreachable", async () => {
  const posts = Array.from({ length: 20 }, (_, index) => post(100 + index));
  const frozen = await core.freezePilotTargets({ posts }, currentPage(posts));
  assert.equal(frozen.current_page_post_count, 20);
  assert.equal(frozen.current_page_candidate_count, 20);
  assert.equal(frozen.targets.length, 3);
  assert.deepEqual([...frozen.targets].map((target) => target.post_uuid), posts.slice(0, 3).map((item) => item.post_uuid));
  assert.equal([...frozen.targets].some((target) => target.post_uuid === posts[3].post_uuid), false);
});

test("current-page UUID missing from cumulative and identity ambiguity fail before dispatch", async () => {
  await assert.rejects(
    core.freezePilotTargets({ posts: [post(1), post(2), post(3)] }, currentPage([post(98), post(99), post(100)])),
    /PILOT_TARGETS_INSUFFICIENT/,
  );
  await assert.rejects(
    core.freezePilotTargets({ posts: [post(1), post(2), post(3)] }, currentPage([post(1), post(1), post(2)])),
    /CURRENT_PAGE_IDENTITY_CONFLICT/,
  );
});

test("future page traversal planner can resume from a persisted UUID checkpoint without duplicates", () => {
  const catalogPosts = Array.from({ length: 60 }, (_, index) => post(200 + index));
  const catalog = { posts: catalogPosts };
  let persistedCheckpoint = { completed_post_uuids: [], last_page: 0 };
  for (let pageNumber = 1; pageNumber <= 3; pageNumber += 1) {
    const start = (pageNumber - 1) * 20;
    const pagePosts = pageNumber === 2
      ? [catalogPosts[19], ...catalogPosts.slice(start, start + 19)]
      : catalogPosts.slice(start, start + 20);
    const selected = core.selectCurrentPageTargets(catalog, currentPage(pagePosts, {
      source_page_url: `https://www.affiliate.myfans.jp/affiliates/search/genres/f-beautiful-woman/result?genre_name=%E7%BE%8E%E5%A5%B3&sexual_orientation=woman&page=${pageNumber}`,
      fingerprint: `page-${pageNumber}`,
    }), {
      max_targets: 20,
      excluded_post_uuids: persistedCheckpoint.completed_post_uuids,
    });
    persistedCheckpoint = structuredClone({
      completed_post_uuids: [
        ...persistedCheckpoint.completed_post_uuids,
        ...selected.targets.map((target) => target.post_uuid),
      ],
      last_page: pageNumber,
    });
  }
  assert.equal(persistedCheckpoint.last_page, 3);
  assert.equal(new Set(persistedCheckpoint.completed_post_uuids).size, persistedCheckpoint.completed_post_uuids.length);
  assert.equal(persistedCheckpoint.completed_post_uuids.includes(catalogPosts[19].post_uuid), true);
});

test("visible success, clipboard-only, rate limit, CAPTCHA, and login are distinct", () => {
  assert.equal(core.classifyVisibleResult({ visible_urls: ["https://link.affiliate.myfans.jp/one"] }).status, "SUCCESS");
  assert.equal(core.classifyVisibleResult({ visible_text: "コピーしました", copy_success_visible: true }).reason, "AUTOMATION_BLOCKED_BY_CLIPBOARD_ONLY_UI");
  assert.equal(core.classifyVisibleResult({ visible_text: "Too Many Requests" }).reason, "RATE_LIMIT_DETECTED");
  assert.equal(core.classifyVisibleResult({ visible_text: "reCAPTCHA" }).reason, "CAPTCHA_OR_ANTI_BOT_DETECTED");
  assert.equal(core.classifyVisibleResult({ has_login_form: true }).reason, "LOGIN_CHALLENGE_DETECTED");
  assert.equal(core.classifyVisibleResult({ visible_text: "この作品は対象外です" }).reason, "AFFILIATE_TARGET_INELIGIBLE");
  assert.equal(core.classifyVisibleResult({ visible_text: "生成中…" }).status, "PENDING");
});

test("official generation capability accepts an exact search-result card without route gating", () => {
  const result = core.classifyGenerationUiAudit({
    authenticated_affiliate_scope: true,
    route: null,
    target_identity_count: 1,
    target_card_count: 1,
    target_card_post_identity_count: 1,
    target_card_action_count: 1,
    input_count: 0,
    generate_control_count: 0,
  });
  assert.equal(result.ready, true);
  assert.equal(result.surface_kind, "SEARCH_RESULT_CARD");
});

test("missing current target card returns the exact pre-action capability failure", () => {
  assert.equal(core.classifyGenerationUiAudit({
    authenticated_affiliate_scope: true,
    route: null,
    target_identity_count: 0,
    target_card_count: 0,
    target_card_post_identity_count: 0,
    target_card_action_count: 0,
    input_count: 0,
    generate_control_count: 0,
  }).reason, "OFFICIAL_AFFILIATE_GENERATION_CAPABILITY_NOT_FOUND");
});

test("dedicated form remains supported but route alone never proves generation capability", () => {
  const form = core.classifyGenerationUiAudit({
    authenticated_affiliate_scope: true,
    route: "/affiliates/url",
    input_count: 1,
    generate_control_count: 1,
    target_card_count: 0,
  });
  assert.equal(form.ready, true);
  assert.equal(form.surface_kind, "DEDICATED_FORM");
  assert.equal(core.classifyGenerationUiAudit({
    authenticated_affiliate_scope: true,
    route: "/affiliates/url",
    input_count: 0,
    generate_control_count: 0,
    target_card_count: 0,
  }).reason, "OFFICIAL_GENERATION_INPUT_NOT_UNIQUE");
  assert.equal(core.classifyGenerationUiAudit({
    authenticated_affiliate_scope: true,
    route: null,
    input_count: 1,
    generate_control_count: 1,
    target_card_count: 0,
  }).reason, "OFFICIAL_AFFILIATE_GENERATION_CAPABILITY_NOT_FOUND");
});

test("exact UUID to card to action mapping fails closed on ambiguity", () => {
  assert.equal(core.classifyGenerationUiAudit({
    authenticated_affiliate_scope: true,
    target_identity_count: 2,
    target_card_count: 2,
    target_card_post_identity_count: 1,
    target_card_action_count: 1,
  }).reason, "AFFILIATE_TARGET_CARD_AMBIGUOUS");
  assert.equal(core.classifyGenerationUiAudit({
    authenticated_affiliate_scope: true,
    target_identity_count: 1,
    target_card_count: 1,
    target_card_post_identity_count: 2,
    target_card_action_count: 1,
  }).reason, "AFFILIATE_TARGET_CARD_IDENTITY_AMBIGUOUS");
  assert.equal(core.classifyGenerationUiAudit({
    authenticated_affiliate_scope: true,
    target_identity_count: 1,
    target_card_count: 1,
    target_card_post_identity_count: 1,
    target_card_action_count: 2,
  }).reason, "OFFICIAL_CARD_GENERATION_CONTROL_NOT_UNIQUE");
  assert.equal(core.classifyGenerationUiAudit({
    authenticated_affiliate_scope: false,
    target_identity_count: 1,
    target_card_count: 1,
    target_card_post_identity_count: 1,
    target_card_action_count: 1,
  }).reason, "AUTHENTICATED_AFFILIATE_CENTER_SCOPE_REQUIRED");
});

test("one explicit pilot action processes exactly three targets with durable cooldown checkpoints", async () => {
  const value = harness();
  const orchestrator = core.createAffiliateGenerationOrchestrator(value.adapters);
  await orchestrator.start({ session_id: "pilot", tab_id: 7, collector_version: "0.6.2" });
  await orchestrator.recover(7);
  assert.equal(value.dispatches.length, 1);
  for (let index = 1; index <= 3; index += 1) {
    const journal = value.storage.dump()[core.ACTIVE_SESSION_KEY];
    await orchestrator.handleResult({
      session_id: "pilot",
      dispatch_nonce: journal.dispatch_nonce,
      result: { visible_urls: [`https://link.affiliate.myfans.jp/generated/${index}`], visible_text: "生成完了" },
    });
    if (index < 3) {
      value.advance(core.GENERATION_COOLDOWN_MS);
      await orchestrator.recover(7);
    }
  }
  const status = (await orchestrator.getStatus()).active;
  assert.equal(status.session_state, "PILOT_COMPLETED");
  assert.equal(status.completed, 3);
  assert.equal(value.dispatches.length, 3);
  assert.equal(value.schedules.length >= 2, true);
});

test("worker restart while waiting inspects but never dispatches the same target again", async () => {
  const value = harness();
  let orchestrator = core.createAffiliateGenerationOrchestrator(value.adapters);
  await orchestrator.start({ session_id: "restart", tab_id: 8, collector_version: "0.6.2" });
  await orchestrator.recover(8);
  assert.equal(value.dispatches.length, 1);
  value.adapters.inspect_result = async () => ({
    visible_urls: ["https://link.affiliate.myfans.jp/generated/recovered"],
    visible_text: "生成完了",
  });
  orchestrator = core.createAffiliateGenerationOrchestrator(value.adapters);
  await orchestrator.recover(8);
  assert.equal(value.dispatches.length, 1);
  assert.equal((await orchestrator.getStatus()).active.completed, 1);
});

test("one generated URL cannot be mapped to two different posts", async () => {
  const value = harness();
  const orchestrator = core.createAffiliateGenerationOrchestrator(value.adapters);
  await orchestrator.start({ session_id: "duplicate-url", tab_id: 10, collector_version: "0.6.2" });
  await orchestrator.recover(10);
  let journal = value.storage.dump()[core.ACTIVE_SESSION_KEY];
  const result = { visible_urls: ["https://link.affiliate.myfans.jp/generated/same"], visible_text: "生成完了" };
  await orchestrator.handleResult({ session_id: "duplicate-url", dispatch_nonce: journal.dispatch_nonce, result });
  value.advance(core.GENERATION_COOLDOWN_MS);
  await orchestrator.recover(10);
  journal = value.storage.dump()[core.ACTIVE_SESSION_KEY];
  await orchestrator.handleResult({ session_id: "duplicate-url", dispatch_nonce: journal.dispatch_nonce, result });
  const status = (await orchestrator.getStatus()).active;
  assert.equal(status.session_state, "FAILED");
  assert.equal(status.failure_reason, "AFFILIATE_URL_REUSED_ACROSS_POSTS");
  assert.equal(status.conflicts, 1);
});

test("duplicate active session is rejected and cancel cannot race an already dispatched write", async () => {
  const value = harness();
  const orchestrator = core.createAffiliateGenerationOrchestrator(value.adapters);
  await orchestrator.start({ session_id: "one", tab_id: 9, collector_version: "0.6.2" });
  await assert.rejects(
    orchestrator.start({ session_id: "two", tab_id: 9, collector_version: "0.6.2" }),
    /DUPLICATE_AFFILIATE_SESSION/,
  );
  await orchestrator.recover(9);
  await assert.rejects(orchestrator.cancel("one"), /ALREADY_DISPATCHED/);
});

test("message or UI stage failure is journaled fail-closed instead of leaving RUNNING", async () => {
  const value = harness();
  value.adapters.prepare_target = async () => { throw new Error("OFFICIAL_GENERATION_INPUT_NOT_UNIQUE"); };
  const orchestrator = core.createAffiliateGenerationOrchestrator(value.adapters);
  await orchestrator.start({ session_id: "stage-failure", tab_id: 11, collector_version: "0.6.2" });
  const status = await orchestrator.recover(11);
  assert.equal(status.session_state, "PAUSED_REQUIRES_RECOVERY");
  assert.equal(status.failure_reason, "OFFICIAL_GENERATION_INPUT_NOT_UNIQUE");
  assert.equal(value.dispatches.length, 0);
});

test("a terminal 0.6.1 paused pre-action journal allows a fresh current-page pilot", async () => {
  const priorPaused = {
    schema_version: core.SESSION_SCHEMA_VERSION,
    collector_version: "0.6.1",
    session_id: "old-paused",
    tab_id: 11,
    scope_key: "scope:test",
    session_state: core.SESSION_STATES.PAUSED_REQUIRES_RECOVERY,
    stage: core.SESSION_STAGES.PAUSED_REQUIRES_RECOVERY,
    revision: 2,
    target_set_hash: "sha256:old",
    eligible_target_count: 1194,
    total_targets: 3,
    current_index: 0,
    completed: 0,
    failed: 1,
    skipped: 0,
    conflicts: 0,
    checkpoint: 0,
    started_at: "2026-09-29T00:00:00.000Z",
    updated_at: "2026-09-29T00:00:01.000Z",
    stop_reason: "OFFICIAL_AFFILIATE_GENERATION_CAPABILITY_NOT_FOUND",
    failure_reason: "OFFICIAL_AFFILIATE_GENERATION_CAPABILITY_NOT_FOUND",
  };
  const value = harness({ storage: { [core.ACTIVE_SESSION_KEY]: priorPaused } });
  const orchestrator = core.createAffiliateGenerationOrchestrator(value.adapters);
  const started = await orchestrator.start({ session_id: "replacement", tab_id: 11, collector_version: "0.6.2" });
  assert.equal(started.session_state, "RUNNING");
  assert.equal(started.current_page_candidate_count, 4);
  assert.equal(value.dispatches.length, 0);
  assert.equal(value.storage.dump()[core.LAST_SESSION_KEY].session_id, "old-paused");
});

test("current-page scope mismatch fails before a pilot journal or click exists", async () => {
  const value = harness({ current_scope_key: "scope:other" });
  const orchestrator = core.createAffiliateGenerationOrchestrator(value.adapters);
  await assert.rejects(
    orchestrator.start({ session_id: "scope-mismatch", tab_id: 14, collector_version: "0.6.2" }),
    /CURRENT_PAGE_SCOPE_MISMATCH/,
  );
  assert.equal(value.dispatches.length, 0);
  assert.equal(value.storage.dump()[core.ACTIVE_SESSION_KEY], undefined);
});

test("clipboard-only search-card result stops after the first dispatched target", async () => {
  const value = harness();
  value.adapters.prepare_target = async () => ({
    ready: true,
    surface_kind: "SEARCH_RESULT_CARD",
    baseline_visible_urls: [],
    baseline_copy_success_visible: false,
    baseline_structural_fingerprint: "before",
  });
  const orchestrator = core.createAffiliateGenerationOrchestrator(value.adapters);
  await orchestrator.start({ session_id: "clipboard-only", tab_id: 12, collector_version: "0.6.2" });
  await orchestrator.recover(12);
  const journal = value.storage.dump()[core.ACTIVE_SESSION_KEY];
  await orchestrator.handleResult({
    session_id: "clipboard-only",
    dispatch_nonce: journal.dispatch_nonce,
    result: {
      visible_urls: [],
      visible_text: "コピーしました",
      copy_success_visible: true,
      structural_fingerprint: "after",
    },
  });
  value.advance(core.GENERATION_COOLDOWN_MS);
  await orchestrator.recover(12);
  const status = (await orchestrator.getStatus()).active;
  assert.equal(status.session_state, "PAUSED_REQUIRES_RECOVERY");
  assert.equal(status.failure_reason, "AUTOMATION_BLOCKED_BY_CLIPBOARD_ONLY_UI");
  assert.equal(status.completed, 0);
  assert.equal(value.dispatches.length, 1);
});

test("unchanged pre-existing copy notice is not mistaken for a new clipboard-only result", async () => {
  const value = harness();
  value.adapters.prepare_target = async () => ({
    ready: true,
    surface_kind: "SEARCH_RESULT_CARD",
    baseline_visible_urls: [],
    baseline_copy_success_visible: true,
    baseline_structural_fingerprint: "same",
  });
  const orchestrator = core.createAffiliateGenerationOrchestrator(value.adapters);
  await orchestrator.start({ session_id: "stale-copy", tab_id: 13, collector_version: "0.6.2" });
  await orchestrator.recover(13);
  const journal = value.storage.dump()[core.ACTIVE_SESSION_KEY];
  const status = await orchestrator.handleResult({
    session_id: "stale-copy",
    dispatch_nonce: journal.dispatch_nonce,
    result: {
      visible_urls: [],
      visible_text: "コピーしました",
      copy_success_visible: true,
      structural_fingerprint: "same",
    },
  });
  assert.equal(status.session_state, "RUNNING");
  assert.equal(status.stage, "WAITING_FOR_RESULT");
  assert.equal(value.dispatches.length, 1);
});
