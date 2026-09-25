import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(testDir, "..");
const runtimeFiles = ["src/collector-core.js", "src/content-script.js", "src/popup.js"];
const runtimeSource = (
  await Promise.all(runtimeFiles.map((file) => readFile(path.join(extensionRoot, file), "utf8")))
).join("\n");
const contentScriptSource = await readFile(path.join(extensionRoot, "src/content-script.js"), "utf8");
const popupSource = await readFile(path.join(extensionRoot, "src/popup.js"), "utf8");
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

test("manifest uses only activeTab, local extension storage, and the single Affiliate Center host", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "0.2.1");
  assert.deepEqual(manifest.permissions, ["activeTab", "storage"]);
  assert.deepEqual(manifest.host_permissions, ["https://www.affiliate.myfans.jp/*"]);
  assert.equal("background" in manifest, false);
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
  assert.deepEqual(scriptSources, ["collector-core.js", "popup.js"]);
});

test("checkpoint persistence uses extension storage only and never page storage", () => {
  assert.match(runtimeSource, /chrome\.storage\.local/);
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

test("production pagination uses the bounded 10-second, 250ms readiness poll", () => {
  assert.match(popupSource, /timeout_ms:\s*10000/);
  assert.match(popupSource, /poll_interval_ms:\s*250/);
});

test("navigation ACK is sent synchronously before the visible next control is clicked", () => {
  const listenerStart = contentScriptSource.indexOf('message.type === "MYFANS_NAVIGATE_NEXT_PREPARE"');
  const ackIndex = contentScriptSource.indexOf("sendResponse({ ok: true, ack: prepared.ack })", listenerStart);
  const clickIndex = contentScriptSource.indexOf("prepared.control.click()", listenerStart);
  const returnIndex = contentScriptSource.indexOf("return false", listenerStart);
  assert.ok(listenerStart >= 0);
  assert.ok(ackIndex > listenerStart);
  assert.ok(clickIndex > ackIndex);
  assert.ok(returnIndex > clickIndex);
});

test("list collection is popup-orchestrated one page at a time", () => {
  assert.match(popupSource, /MYFANS_COLLECT_CURRENT_PAGE/);
  assert.match(popupSource, /MYFANS_NAVIGATE_NEXT_PREPARE/);
  assert.match(popupSource, /executeNavigationSafeRun/);
  assert.equal(runtimeSource.includes("MYFANS_COLLECT_LIST"), false);
  assert.equal(runtimeSource.includes("MYFANS_PREPARE_RESUME"), false);
});

test("the only cumulative storage write occurs inside the completed run commit callback", () => {
  assert.equal((popupSource.match(/saveCatalogMap\(/g) || []).length, 2);
  const commitStart = popupSource.indexOf("commit_run: async (run)");
  const storageWrite = popupSource.indexOf("await saveCatalogMap(updatedCatalogMap)", commitStart);
  assert.ok(commitStart >= 0);
  assert.ok(storageWrite > commitStart);
});
