import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MODERN_BROWSER_SOURCE_TYPE,
  chromeMajorFromVersion,
  createModernBrowserRenderer,
  probeModernBrowserEnvironment,
  validateModernBrowserUrl,
} from "../scripts/lib/myfans-modern-browser-renderer.mjs";
import {
  CLOUD_ARTIFACT_FILES,
  runCloudPilot,
  validateCloudArtifactDirectory,
} from "../scripts/myfans-cloud-public-pilot.mjs";
import {
  MYFANS_CLASSIFICATIONS,
  discoverCreatorCandidatesFromRanking,
  parseCreatorPage,
} from "../scripts/lib/myfans-public-metadata.mjs";

const creatorUrl = "https://myfans.jp/public_creator";
const postUrl = "https://myfans.jp/posts/123e4567-e89b-42d3-a456-426614174000";
const rankingUrl = "https://myfans.jp/ranking/creators/all?term=daily";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 8111;
    this.alive = true;
    this.stderr = new EventEmitter();
    this.signals = [];
  }

  kill(signal) {
    this.signals.push(signal);
    this.alive = false;
    queueMicrotask(() => this.emit("exit", 0, signal));
    return true;
  }
}

function observation(url, overrides = {}) {
  return {
    href: url,
    title: url === "https://example.com/" ? "Example Domain" : "Rendered public page",
    readyState: "complete",
    domLength: 500,
    textLength: 100,
    errorPage: false,
    certificateWarning: false,
    challenge: false,
    authWall: false,
    ageWall: false,
    authenticatedSessionPresent: false,
    rankingRelated: url.includes("/ranking/"),
    rankLikeContent: url.includes("/ranking/"),
    anchorCount: 1,
    structuralUnits: [],
    ...overrides,
  };
}

function rendererHarness({ navigateError = null, observed = null, endpointError = null } = {}) {
  const child = new FakeChild();
  const calls = [];
  const spawnCalls = [];
  const removed = [];
  let currentUrl = "about:blank";
  const client = {
    async send(method, params = {}, sessionId = null) {
      calls.push({ method, params, sessionId });
      if (method === "Target.createBrowserContext") return { browserContextId: "context-1" };
      if (method === "Target.createTarget") return { targetId: "target-1" };
      if (method === "Target.attachToTarget") return { sessionId: "session-1" };
      if (method === "Page.navigate") {
        currentUrl = params.url;
        return navigateError ? { errorText: navigateError } : { frameId: "frame-1" };
      }
      if (method === "Runtime.evaluate") {
        if (params.expression === "document.documentElement?.outerHTML || ''") {
          return { result: { value: "<html><head><title>Rendered</title></head><body>public metadata</body></html>" } };
        }
        return { result: { value: observed ?? observation(currentUrl) } };
      }
      return {};
    },
    on() {
      return () => {};
    },
    close() {},
  };
  const renderer = createModernBrowserRenderer({
    browser: {
      browser_path: "/usr/bin/google-chrome",
      browser_version: "Google Chrome 140.0.0.0",
      browser_major: 140,
      modern_browser_available: true,
    },
    spawnImpl: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return child;
    },
    fetchImpl: async () => {
      if (!child.alive) throw new TypeError("listener stopped");
      return new Response("{}", { status: 200 });
    },
    connectCdpImpl: async () => client,
    discoverEndpointImpl: async () => {
      if (endpointError) throw new Error(endpointError);
      return "ws://127.0.0.1:45555/devtools/browser/fake";
    },
    reservePortImpl: async () => 45555,
    mkdtempImpl: async () => "/tmp/okazu-modern-fake-profile",
    rmImpl: async (directory) => removed.push(directory),
    processAliveImpl: () => child.alive,
    sleepImpl: async () => {},
    maxWaitMs: 20,
  });
  return { renderer, child, calls, spawnCalls, removed };
}

function creatorHtml() {
  return `<html><head><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Person",
    name: "Public Creator",
    url: creatorUrl,
  })}</script></head><body><a href="${postUrl}">post</a></body></html>`;
}

function postHtml() {
  return `<html><head><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Article",
    headline: "Public Post",
    url: postUrl,
    author: { "@type": "Person", url: creatorUrl },
    isAccessibleForFree: true,
  })}</script></head><body><p>public</p></body></html>`;
}

function fakeEnvironment(available = true) {
  return {
    generated_at: "2026-09-08T00:00:00.000Z",
    runner_os: "Linux",
    os_release: { name: "Ubuntu" },
    architecture: "x64",
    node_version: "v22.0.0",
    browser_path: available ? "/usr/bin/google-chrome" : null,
    browser_version: available ? "Google Chrome 140.0.0.0" : null,
    browser_major: available ? 140 : null,
    modern_browser_available: available,
    new_browser_install: 0,
    browser_download: 0,
  };
}

function fakePilotRenderer({ rankingStructures = 1, neutralFailure = false } = {}) {
  const calls = [];
  let closed = false;
  const requests = [];
  const render = async (url, { label }) => {
    calls.push(url);
    requests.push({ url, label, attempt: 0, status: 200 });
    if (neutralFailure && url === "https://example.com/") throw new Error("neutral failed");
    if (url === "https://example.com/") return {
      url, status: 200, location: null, html: "<html><title>Example Domain</title><body>Example Domain</body></html>", fetched_at: new Date().toISOString(), rendered_units: [],
      render_observation: { ...observation(url), title: "Example Domain", ready_state: "complete", dom_length: 100, text_length: 14, anchor_count: 1, rank_like_content: false, ranking_related: false, href: url },
    };
    if (url === rankingUrl) {
      const units = rankingStructures ? [{ rank: 1, links: [{ href: creatorUrl, text: "Public Creator" }] }] : [];
      return {
        url, status: 200, location: null, html: "<html><title>Ranking</title><body>1位 Public Creator</body></html>", fetched_at: new Date().toISOString(), rendered_units: units,
        render_observation: { ...observation(url), title: "Creator Ranking", ready_state: "complete", dom_length: 200, text_length: 20, anchor_count: units.length, rank_like_content: Boolean(units.length), ranking_related: true, href: url },
      };
    }
    const html = url === creatorUrl ? creatorHtml() : postHtml();
    return {
      url, status: 200, location: null, html, fetched_at: new Date().toISOString(), rendered_units: [],
      render_observation: { ...observation(url), ready_state: "complete", dom_length: html.length, text_length: 20, anchor_count: 1, rank_like_content: false, ranking_related: false, href: url },
    };
  };
  const summary = () => ({
    source_type: MODERN_BROWSER_SOURCE_TYPE,
    actual_requests: requests.length,
    retry_requests: 0,
    duplicate_requests: 0,
    requests,
    browser_generated_request_types: { Document: requests.length, Image: 0, Media: 0 },
    cleanup: { closed, browser_process_alive: false, cdp_listener_active: false, temp_profile_present: false },
  });
  return {
    calls,
    renderer: {
      async start() {},
      render,
      async close() {
        closed = true;
        return summary();
      },
      summary,
    },
  };
}

test("runner probe accepts a preinstalled modern Chrome and fails closed when absent", async () => {
  const present = await probeModernBrowserEnvironment({
    candidates: ["/usr/bin/google-chrome"],
    accessImpl: async () => {},
    versionImpl: async () => "Google Chrome 140.0.7339.80",
    osReleaseImpl: async () => ({ name: "Ubuntu" }),
  });
  assert.equal(present.modern_browser_available, true);
  assert.equal(present.new_browser_install, 0);
  assert.equal(chromeMajorFromVersion(present.browser_version), 140);
  const absent = await probeModernBrowserEnvironment({
    candidates: ["/missing"],
    accessImpl: async () => { throw new Error("missing"); },
    osReleaseImpl: async () => ({}),
  });
  assert.equal(absent.modern_browser_available, false);
  assert.equal(absent.availability_reason, "PREINSTALLED_CHROME_NOT_FOUND");
});

test("modern renderer uses fresh localhost CDP, blocks media, denies downloads, and cleans up", async () => {
  const { renderer, child, calls, spawnCalls, removed } = rendererHarness();
  await renderer.start();
  const response = await renderer.render("https://example.com/", { label: "neutral" });
  assert.equal(response.render_observation.title, "Example Domain");
  const result = await renderer.close();
  assert.equal(result.cleanup.browser_process_alive, false);
  assert.equal(result.cleanup.cdp_listener_active, false);
  assert.equal(result.cleanup.temp_profile_present, false);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.deepEqual(removed, ["/tmp/okazu-modern-fake-profile"]);
  assert.ok(spawnCalls[0].args.includes("--remote-debugging-address=127.0.0.1"));
  assert.ok(spawnCalls[0].args.includes("--headless=new"));
  assert.ok(spawnCalls[0].args.some((value) => value.startsWith("--user-data-dir=/tmp/okazu-modern-fake-profile")));
  assert.ok(calls.some((call) => call.method === "Target.createBrowserContext"));
  assert.ok(calls.some((call) => call.method === "Network.setBlockedURLs" && call.params.urls.includes("*.mp4")));
  assert.ok(calls.some((call) => call.method === "Browser.setDownloadBehavior" && call.params.behavior === "deny"));
});

test("modern renderer removes its fresh profile when CDP startup fails", async () => {
  const { renderer, child, removed } = rendererHarness({ endpointError: "CDP unavailable" });
  await assert.rejects(renderer.start(), /CDP unavailable/);
  assert.equal(child.alive, false);
  assert.deepEqual(removed, ["/tmp/okazu-modern-fake-profile"]);
});

test("modern renderer allowlist and duplicate budget fail closed", async () => {
  assert.equal(validateModernBrowserUrl(rankingUrl), rankingUrl);
  assert.equal(validateModernBrowserUrl(creatorUrl), creatorUrl);
  assert.equal(validateModernBrowserUrl(postUrl), postUrl);
  assert.throws(() => validateModernBrowserUrl("https://evil.example/"), /MODERN_BROWSER_URL_REJECTED/);
  assert.throws(() => validateModernBrowserUrl("https://myfans.jp/login"), /MODERN_BROWSER_URL_REJECTED/);
  const { renderer } = rendererHarness();
  await renderer.start();
  await renderer.render("https://example.com/");
  await assert.rejects(renderer.render("https://example.com/"), /DUPLICATE_REQUEST_URL_BLOCKED/);
  await renderer.close();
});

test("real certificate navigation errors fail without bypass", async () => {
  const { renderer } = rendererHarness({ navigateError: "net::ERR_CERT_DATE_INVALID" });
  await renderer.start();
  await assert.rejects(renderer.render("https://example.com/"), /ERR_CERT_DATE_INVALID|MODERN_BROWSER_CERTIFICATE_ERROR/);
  const result = await renderer.close();
  assert.equal(result.actual_requests, 1);
  assert.equal(result.cleanup.browser_process_alive, false);
});

test("modern ranking parser excludes system routes and requires one strict profile per unit", () => {
  const candidates = discoverCreatorCandidatesFromRanking("<html></html>", rankingUrl, {
    renderedSource: "modern_browser",
    includeGenericAnchors: false,
    renderedUnits: [
      { rank: 1, links: [{ href: creatorUrl, text: "Public Creator" }] },
      { rank: 2, links: [{ href: "https://myfans.jp/unlimited", text: "Unlimited" }] },
      { rank: 3, links: [{ href: "https://myfans.jp/genres", text: "Genres" }] },
      { rank: 4, links: [{ href: "https://myfans.jp/a", text: "A" }, { href: "https://myfans.jp/b", text: "B" }] },
    ],
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].candidate_slug, "public_creator");
  assert.equal(candidates[0].discovery_method, "modern_browser_rendered_ranking_unit");
});

test("unknown one-segment and generic marketing pages remain SAFE0", () => {
  const generic = parseCreatorPage({
    html: "<html><head><title>Marketing</title><meta property='og:title' content='Marketing'></head><body>generic</body></html>",
    sourceUrl: "https://myfans.jp/plain_navigation",
    discoveryEvidence: [],
  });
  assert.notEqual(generic.classification, MYFANS_CLASSIFICATIONS.SAFE);
});

test("cloud pilot enforces neutral gate before MyFans navigation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myfans-cloud-neutral-test-"));
  const fake = fakePilotRenderer({ neutralFailure: true });
  try {
    const result = await runCloudPilot({
      outputDir: directory,
      environmentProbe: async () => fakeEnvironment(),
      rendererFactory: () => fake.renderer,
    });
    assert.equal(result.outcome, "PHASE6C_CLOUD_BROWSER_RUNNER_FAILED");
    assert.deepEqual(fake.calls, ["https://example.com/"]);
    assert.equal(result.artifact_validation.valid, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cloud pilot stops after one ranking navigation when modern DOM has zero creator units", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myfans-cloud-zero-test-"));
  const fake = fakePilotRenderer({ rankingStructures: 0 });
  try {
    const result = await runCloudPilot({
      outputDir: directory,
      environmentProbe: async () => fakeEnvironment(),
      rendererFactory: () => fake.renderer,
    });
    assert.equal(result.outcome, "PHASE6C_MYFANS_PUBLIC_RANKING_NOT_AUTOMATABLE");
    assert.deepEqual(fake.calls, ["https://example.com/", rankingUrl]);
    assert.equal(result.safe_creators, 0);
    assert.equal(result.artifact_validation.file_count, CLOUD_ARTIFACT_FILES.length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("positive cloud fixture freezes one SAFE creator and one public UUID post", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myfans-cloud-positive-test-"));
  const fake = fakePilotRenderer();
  try {
    const result = await runCloudPilot({
      outputDir: directory,
      environmentProbe: async () => fakeEnvironment(),
      rendererFactory: () => fake.renderer,
    });
    assert.equal(result.outcome, "PHASE6C_MYFANS_MODERN_BROWSER_PILOT_COMPLETE");
    assert.equal(result.safe_creators, 1);
    assert.equal(result.safe_posts, 1);
    assert.equal(result.post_detail_verified, true);
    assert.deepEqual(fake.calls, ["https://example.com/", rankingUrl, creatorUrl, postUrl]);
    assert.match(result.artifact_validation.manifest_sha256, /^[0-9a-f]{64}$/);
    assert.match(result.artifact_validation.membership_sha256, /^[0-9a-f]{64}$/);
    assert.match(result.artifact_validation.payload_sha256, /^[0-9a-f]{64}$/);
    const restored = JSON.parse(await readFile(path.join(directory, "safe-creators.json"), "utf8"));
    assert.equal(restored.records[0].source_type, MODERN_BROWSER_SOURCE_TYPE);
    assert.doesNotMatch(JSON.stringify(restored), /<html|<body|<script/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("artifact validation rejects files outside the fixed structured allowlist", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myfans-cloud-artifact-test-"));
  const fake = fakePilotRenderer({ rankingStructures: 0 });
  try {
    await runCloudPilot({ outputDir: directory, environmentProbe: async () => fakeEnvironment(), rendererFactory: () => fake.renderer });
    await writeFile(path.join(directory, "raw-dom.html"), "<html></html>");
    await assert.rejects(validateCloudArtifactDirectory(directory), /CLOUD_ARTIFACT_FILE_ALLOWLIST_FAILED/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("workflow is dispatch-only, minimally permissioned, fixed-input, and secret-free", async () => {
  const workflow = await readFile(new URL("../.github/workflows/myfans-public-browser-pilot.yml", import.meta.url), "utf8");
  assert.match(workflow, /^on:\n  workflow_dispatch:\s*$/m);
  assert.match(workflow, /^permissions:\n  contents: read\s*$/m);
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.doesNotMatch(workflow, /pull_request_target|schedule:|^\s+push:|^\s+inputs:/m);
  assert.doesNotMatch(workflow, /secrets\.|id-token:|packages:|pull-requests:|contents: write/);
  assert.doesNotMatch(workflow, /apt(?:-get)?\s+install|playwright\s+install|puppeteer|ignore-certificate|--no-sandbox/i);
  assert.match(workflow, /node scripts\/myfans-cloud-public-pilot[.]mjs --output-dir/);
  assert.match(workflow, /myfans-public-pilot-\$\{\{ github[.]run_id \}\}/);
});

test("modern browser implementation contains no bypass, auth extraction, cookie export, or media persistence", async () => {
  const renderer = await readFile(new URL("../scripts/lib/myfans-modern-browser-renderer.mjs", import.meta.url), "utf8");
  const pilot = await readFile(new URL("../scripts/myfans-cloud-public-pilot.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(renderer, /ignore-certificate|allow-insecure-localhost|disable-web-security|--proxy-server|--no-sandbox|stealth/i);
  assert.doesNotMatch(renderer, /Network[.]getResponseBody|Storage[.]getCookies|Network[.]getCookies|localStorage|sessionStorage/i);
  assert.doesNotMatch(pilot, /process[.]env[.](?:SUPABASE|VERCEL|FANZA)|secrets[.]/i);
  assert.match(renderer, /Network[.]setBlockedURLs/);
  assert.match(renderer, /Browser[.]setDownloadBehavior/);
});
