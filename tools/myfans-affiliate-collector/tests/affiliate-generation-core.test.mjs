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

function harness() {
  const storage = fakeStorage();
  let now = Date.parse("2026-09-29T00:00:00.000Z");
  const dispatches = [];
  const schedules = [];
  const adapters = {
    storage,
    now: () => now,
    uuid: () => `nonce-${dispatches.length + 1}`,
    get_catalog: async () => ({
      scope_key: "scope:test",
      catalog: { posts: [post(1), post(2), post(3), post(4)] },
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

test("pilot target freeze excludes ACTIVE, ineligible, and malformed records and caps at three", async () => {
  const catalog = { posts: [
    post(4), post(3), post(2), post(1),
    post(5, { affiliate_eligible: false }),
    post(6, { displayed_affiliate_url: "https://link.affiliate.myfans.jp/existing" }),
    post(7, { post_public_url: "https://example.test/post" }),
  ] };
  const frozen = await core.freezePilotTargets(catalog);
  assert.equal(frozen.pilot_target_count, 3);
  assert.equal(frozen.eligible_target_count, 4);
  assert.deepEqual([...frozen.targets].map((target) => target.post_uuid), [post(1).post_uuid, post(2).post_uuid, post(3).post_uuid]);
  await assert.rejects(core.freezePilotTargets(catalog, { expected_target_hash: "sha256:wrong" }), /ATTESTATION_MISMATCH/);
  await assert.rejects(core.freezePilotTargets(catalog, { expected_eligible_count: 1194 }), /TARGET_COUNT_MISMATCH/);
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

test("official generation UI requires one route, input, and generate control", () => {
  assert.equal(core.classifyGenerationUiAudit({ route: "/affiliates/url", input_count: 1, generate_control_count: 1 }).ready, true);
  assert.equal(core.classifyGenerationUiAudit({ route: null, input_count: 1, generate_control_count: 1 }).reason, "OFFICIAL_GENERATION_ROUTE_REQUIRED");
  assert.equal(core.classifyGenerationUiAudit({ route: "/affiliates/url", input_count: 0, generate_control_count: 1 }).reason, "OFFICIAL_GENERATION_INPUT_NOT_UNIQUE");
  assert.equal(core.classifyGenerationUiAudit({ route: "/affiliates/url", input_count: 1, generate_control_count: 2 }).reason, "OFFICIAL_GENERATE_CONTROL_NOT_UNIQUE");
});

test("one explicit pilot action processes exactly three targets with durable cooldown checkpoints", async () => {
  const value = harness();
  const orchestrator = core.createAffiliateGenerationOrchestrator(value.adapters);
  await orchestrator.start({ session_id: "pilot", tab_id: 7, collector_version: "0.6.0" });
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
  await orchestrator.start({ session_id: "restart", tab_id: 8, collector_version: "0.6.0" });
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
  await orchestrator.start({ session_id: "duplicate-url", tab_id: 10, collector_version: "0.6.0" });
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
  await orchestrator.start({ session_id: "one", tab_id: 9, collector_version: "0.6.0" });
  await assert.rejects(
    orchestrator.start({ session_id: "two", tab_id: 9, collector_version: "0.6.0" }),
    /DUPLICATE_AFFILIATE_SESSION/,
  );
  await orchestrator.recover(9);
  await assert.rejects(orchestrator.cancel("one"), /ALREADY_DISPATCHED/);
});

test("message or UI stage failure is journaled fail-closed instead of leaving RUNNING", async () => {
  const value = harness();
  value.adapters.prepare_target = async () => { throw new Error("OFFICIAL_GENERATION_INPUT_NOT_UNIQUE"); };
  const orchestrator = core.createAffiliateGenerationOrchestrator(value.adapters);
  await orchestrator.start({ session_id: "stage-failure", tab_id: 11, collector_version: "0.6.0" });
  const status = await orchestrator.recover(11);
  assert.equal(status.session_state, "PAUSED_REQUIRES_RECOVERY");
  assert.equal(status.failure_reason, "OFFICIAL_GENERATION_INPUT_NOT_UNIQUE");
  assert.equal(value.dispatches.length, 0);
});
