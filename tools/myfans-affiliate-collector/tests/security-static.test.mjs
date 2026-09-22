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

test("manifest uses only activeTab and the single Affiliate Center host", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "0.1.4");
  assert.deepEqual(manifest.permissions, ["activeTab"]);
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
  assert.deepEqual(scriptSources, ["popup.js"]);
});

test("runtime never reads form values", () => {
  assert.equal(/\.value\b/.test(runtimeSource), false);
});

test("production pagination uses the bounded 10-second, 250ms readiness poll", () => {
  assert.match(contentScriptSource, /timeout_ms:\s*10000/);
  assert.match(contentScriptSource, /poll_interval_ms:\s*250/);
});
