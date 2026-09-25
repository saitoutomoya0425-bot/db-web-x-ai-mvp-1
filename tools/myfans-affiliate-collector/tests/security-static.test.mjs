import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(testDir, "..");
const runtimeFiles = [
  "src/collector-core.js",
  "src/orchestrator-core.js",
  "src/background.js",
  "src/content-script.js",
  "src/popup.js"
];
const sources = Object.fromEntries(await Promise.all(runtimeFiles.map(async (file) => [
  file,
  await readFile(path.join(extensionRoot, file), "utf8")
])));
const runtimeSource = Object.values(sources).join("\n");
const contentScriptSource = sources["src/content-script.js"];
const orchestratorSource = sources["src/orchestrator-core.js"];
const backgroundSource = sources["src/background.js"];
const popupSource = sources["src/popup.js"];
const manifest = JSON.parse(await readFile(path.join(extensionRoot, "manifest.json"), "utf8"));
const popupHtml = await readFile(path.join(extensionRoot, "src/popup.html"), "utf8");

test("runtime has no network, credential-store, browser-debug, or interception APIs", () => {
  const forbiddenPatterns = [
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /chrome\.cookies/,
    /chrome\.debugger/,
    /chrome\.webRequest/,
    /declarativeNetRequest/,
    /localStorage/,
    /sessionStorage/,
    /\.outerHTML\b/,
    /\.innerHTML\b/
  ];
  for (const pattern of forbiddenPatterns) {
    assert.equal(pattern.test(runtimeSource), false, `forbidden runtime pattern: ${pattern}`);
  }
});

test("manifest adds only an MV3 service worker and keeps the prior least privileges", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "0.3.1");
  assert.deepEqual(manifest.permissions, ["activeTab", "storage"]);
  assert.deepEqual(manifest.host_permissions, ["https://www.affiliate.myfans.jp/*"]);
  assert.deepEqual(manifest.background, { service_worker: "src/background.js" });
  assert.equal("web_accessible_resources" in manifest, false);
  assert.deepEqual(manifest.content_scripts[0].matches, [
    "https://www.affiliate.myfans.jp/affiliates/search*",
    "https://www.affiliate.myfans.jp/affiliates/generated*"
  ]);
});

test("popup has no image, video, canvas, iframe, or remote script elements", () => {
  for (const tag of ["img", "video", "canvas", "iframe"]) {
    assert.equal(new RegExp(`<${tag}\\b`, "i").test(popupHtml), false);
  }
  const scriptSources = [...popupHtml.matchAll(/<script\s+src="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(scriptSources, ["popup.js"]);
});

test("journal and cumulative persistence use extension storage only", () => {
  assert.match(backgroundSource, /storage:\s*chrome\.storage\.local/);
  assert.match(orchestratorSource, /ACTIVE_OPERATION_KEY/);
  assert.match(orchestratorSource, /CATALOG_KEY/);
  assert.equal(/\b(?:window\.)?localStorage\b/.test(runtimeSource), false);
  assert.equal(/\b(?:window\.)?sessionStorage\b/.test(runtimeSource), false);
});

test("runtime never reads form values", () => {
  assert.equal(/\.value\b/.test(runtimeSource), false);
});

test("missing-title segment diagnostics use rendered innerText only", () => {
  assert.match(
    contentScriptSource,
    /function diagnosticVisibleSegmentCandidates[\s\S]*?String\(element\.innerText \|\| ""\)/
  );
});

test("readiness is bounded to ten seconds with 250ms polling and settle windows", () => {
  assert.match(orchestratorSource, /READY_TIMEOUT_MS\s*=\s*10000/);
  assert.match(orchestratorSource, /READY_POLL_INTERVAL_MS\s*=\s*250/);
  assert.match(orchestratorSource, /READY_SETTLE_MS\s*=\s*250/);
  for (const field of [
    "readiness_started_at",
    "readiness_deadline",
    "last_observed_page",
    "last_observed_record_count",
    "last_observed_fingerprint",
    "settle_candidate_fingerprint",
    "settle_candidate_at"
  ]) assert.match(orchestratorSource, new RegExp(field));
  assert.match(contentScriptSource, /setInterval\([\s\S]*?250/);
  assert.match(contentScriptSource, /},\s*10000\)/);
});

test("PREPARE returns its ACK without navigating", () => {
  const listenerStart = contentScriptSource.indexOf('message.type === "MYFANS_PREPARE_NAVIGATION"');
  const nextListener = contentScriptSource.indexOf('message.type === "MYFANS_NAVIGATE_NOW"', listenerStart);
  const handler = contentScriptSource.slice(listenerStart, nextListener);
  assert.ok(listenerStart >= 0);
  assert.match(handler, /sendResponse\(\{ ok: true, ack: prepared\.ack \}\)/);
  assert.equal(handler.includes(".click()"), false);
});

test("NAVIGATE_NOW ACK is sent before the visible control click is scheduled", () => {
  const listenerStart = contentScriptSource.indexOf('message.type === "MYFANS_NAVIGATE_NOW"');
  const ackIndex = contentScriptSource.indexOf("sendResponse({", listenerStart);
  const clickIndex = contentScriptSource.indexOf("prepared.control.click()", listenerStart);
  assert.ok(listenerStart >= 0);
  assert.ok(ackIndex > listenerStart);
  assert.ok(clickIndex > ackIndex);
  assert.match(contentScriptSource.slice(ackIndex, clickIndex + 30), /setTimeout\(\(\) => prepared\.control\.click\(\), 0\)/);
});

test("service worker owns orchestration while popup is controller/view only", () => {
  assert.match(backgroundSource, /createDurableOrchestrator/);
  assert.match(backgroundSource, /recoverActive/);
  assert.match(popupSource, /MYFANS_ORCHESTRATOR_START/);
  assert.match(popupSource, /MYFANS_ORCHESTRATOR_STATUS/);
  assert.equal(popupSource.includes("executeNavigationSafeRun"), false);
  assert.equal(popupSource.includes("MYFANS_NAVIGATE_NOW"), false);
  assert.equal(runtimeSource.includes("MYFANS_COLLECT_LIST"), false);
});

test("formal cumulative catalog is committed only by the durable commit operation", () => {
  assert.equal(popupSource.includes("myfansCumulativeCatalogsV1"), false);
  const commitStart = orchestratorSource.indexOf("async function commitOperation");
  const atomicSet = orchestratorSource.indexOf("await adapters.storage.set({", commitStart);
  const catalogsWrite = orchestratorSource.indexOf("[CATALOG_KEY]: catalogs", atomicSet);
  const completedWrite = orchestratorSource.indexOf("[ACTIVE_OPERATION_KEY]: completed", atomicSet);
  assert.ok(commitStart >= 0);
  assert.ok(atomicSet > commitStart);
  assert.ok(catalogsWrite > atomicSet);
  assert.ok(completedWrite > catalogsWrite);
});

test("popup receives status from the journal and cannot broaden collection limits", () => {
  assert.match(popupSource, /pages_staged/);
  assert.match(popupSource, /max_pages/);
  assert.equal(/max_pages\s*:\s*(?:[6-9]|[1-9]\d+)/.test(popupSource), false);
});
