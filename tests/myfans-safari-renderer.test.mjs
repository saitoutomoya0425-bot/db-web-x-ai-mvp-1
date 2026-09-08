import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertLocalWebDriverBaseUrl,
  createSafariWebDriverRenderer,
  validateSafariRenderUrl,
} from "../scripts/lib/myfans-safari-renderer.mjs";
import { discoverCreatorCandidatesFromRanking } from "../scripts/lib/myfans-public-metadata.mjs";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 4242;
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

function json(value, status = 200) {
  return new Response(JSON.stringify({ value }), { status, headers: { "content-type": "application/json" } });
}

function harness({ observation, source = "<html><head><title>Rendered</title></head><body>public</body></html>", sessionError = null, rendererOptions = {} } = {}) {
  const child = new FakeChild();
  const calls = [];
  let currentUrl = "about:blank";
  const defaultObservation = {
    href: "https://example.com/",
    title: "Example Domain",
    readyState: "complete",
    domLength: 100,
    textLength: 20,
    errorPage: false,
    certificateWarning: false,
    challenge: false,
    authWall: false,
    ageWall: false,
    authenticatedSessionPresent: false,
    rankingRelated: false,
    structuralUnits: [],
  };
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    calls.push({ pathname: parsed.pathname, method: options.method ?? "GET", body: options.body ? JSON.parse(options.body) : null });
    if (parsed.pathname === "/status") {
      if (!child.alive) throw new TypeError("driver stopped");
      return json({ ready: true });
    }
    if (parsed.pathname === "/session" && options.method === "POST") return sessionError
      ? json({ error: "session not created", message: sessionError })
      : json({ sessionId: "session-1", capabilities: { browserName: "Safari", acceptInsecureCerts: false } });
    if (parsed.pathname.endsWith("/timeouts")) return json(null);
    if (parsed.pathname.endsWith("/url") && options.method === "POST") {
      currentUrl = JSON.parse(options.body).url;
      return json(null);
    }
    if (parsed.pathname.endsWith("/execute/sync")) {
      const value = typeof observation === "function" ? observation(currentUrl) : observation;
      return json(value ?? { ...defaultObservation, href: currentUrl.startsWith("data:") ? currentUrl : defaultObservation.href });
    }
    if (parsed.pathname.endsWith("/source")) return json(source);
    if (parsed.pathname.endsWith("/session-1") && options.method === "DELETE") return json(null);
    throw new Error(`UNEXPECTED_WEBDRIVER_CALL:${parsed.pathname}`);
  };
  const renderer = createSafariWebDriverRenderer({
    fetchImpl,
    spawnImpl: () => child,
    accessImpl: async () => {},
    reservePortImpl: async () => 45555,
    sleepImpl: async () => {},
    processAliveImpl: () => child.alive,
    maxWaitMs: 20,
    ...rendererOptions,
  });
  return { renderer, child, calls };
}

test("Safari renderer accepts only a local WebDriver endpoint and approved public navigation", () => {
  assert.equal(assertLocalWebDriverBaseUrl("http://127.0.0.1:5555/"), "http://127.0.0.1:5555");
  assert.throws(() => assertLocalWebDriverBaseUrl("http://0.0.0.0:5555/"), /NON_LOCAL_WEBDRIVER_ENDPOINT/);
  assert.throws(() => assertLocalWebDriverBaseUrl("https://127.0.0.1:5555/"), /NON_LOCAL_WEBDRIVER_ENDPOINT/);
  assert.equal(validateSafariRenderUrl("https://example.com/"), "https://example.com/");
  assert.equal(validateSafariRenderUrl("https://myfans.jp/ranking/creators/all?term=daily"), "https://myfans.jp/ranking/creators/all?term=daily");
  assert.equal(validateSafariRenderUrl("https://myfans.jp/public_creator"), "https://myfans.jp/public_creator");
  assert.throws(() => validateSafariRenderUrl("https://myfans.jp/login"), /SAFARI_NAVIGATION_URL_REJECTED/);
  assert.throws(() => validateSafariRenderUrl("https://evil.example/"), /SAFARI_NAVIGATION_URL_REJECTED/);
});

test("Safari renderer checks driver availability before session creation", async () => {
  const renderer = createSafariWebDriverRenderer({ accessImpl: async () => { throw new Error("missing"); } });
  await assert.rejects(renderer.start(), /SAFARIDRIVER_UNAVAILABLE/);
});

test("Safari renderer cleans up its owned driver when session creation fails", async () => {
  const { renderer, child } = harness({ sessionError: "Remote Automation unavailable" });
  await assert.rejects(renderer.start(), /Remote Automation unavailable/);
  assert.equal(child.alive, false);
  assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("Safari renderer creates a certificate-validating session, navigates, and cleans up its owned driver", async () => {
  const { renderer, child, calls } = harness();
  const started = await renderer.start();
  assert.equal(started.capabilities.acceptInsecureCerts, false);
  const response = await renderer.render("https://example.com/", { label: "neutral" });
  assert.equal(response.status, 200);
  assert.equal(response.render_observation.title, "Example Domain");
  assert.ok(response.html.length > 0);
  const summary = await renderer.close();
  assert.equal(summary.cleanup.session_active, false);
  assert.equal(summary.cleanup.driver_process_alive, false);
  assert.equal(summary.cleanup.driver_listener_active, false);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.ok(calls.some((call) => call.pathname === "/session" && call.method === "POST"));
  assert.ok(calls.some((call) => call.pathname.endsWith("/url") && call.method === "POST"));
  assert.ok(calls.some((call) => call.pathname.endsWith("/session-1") && call.method === "DELETE"));
});

test("Safari renderer fails closed on bounded timeout and still cleans up", async () => {
  const { renderer } = harness({ observation: {
    href: "about:blank", title: "", readyState: "loading", domLength: 0, textLength: 0,
    errorPage: false, certificateWarning: false, challenge: false, authWall: false,
    ageWall: false, authenticatedSessionPresent: false, rankingRelated: false, structuralUnits: [],
  } });
  await renderer.start();
  await assert.rejects(renderer.render("https://example.com/"), /SAFARI_RENDER_TIMEOUT/);
  const summary = await renderer.close();
  assert.equal(summary.cleanup.driver_process_alive, false);
});

test("Safari renderer rejects an oversized transient page source", async () => {
  const { renderer } = harness({ source: "x".repeat(101), rendererOptions: { maxHtmlBytes: 100 } });
  await renderer.start();
  await assert.rejects(renderer.render("https://example.com/"), /SAFARI_HTML_RESPONSE_TOO_LARGE/);
  await renderer.close();
});

test("Safari renderer rejects certificate warnings and authenticated sessions", async () => {
  for (const field of ["certificateWarning", "authenticatedSessionPresent"]) {
    const { renderer } = harness({ observation: {
      href: "https://example.com/", title: "unsafe", readyState: "complete", domLength: 10, textLength: 10,
      errorPage: false, certificateWarning: field === "certificateWarning", challenge: false, authWall: false,
      ageWall: false, authenticatedSessionPresent: field === "authenticatedSessionPresent", rankingRelated: false, structuralUnits: [],
    } });
    await renderer.start();
    await assert.rejects(renderer.render("https://example.com/"), field === "certificateWarning" ? /SAFARI_CERTIFICATE_WARNING/ : /AUTH_SESSION_PRESENT/);
    await renderer.close();
  }
});

test("rendered ranking parser requires rank, display name, and profile URL in one structural unit", () => {
  const rankingUrl = "https://myfans.jp/ranking/creators/all?term=daily";
  const units = [
    { rank: 1, links: [{ href: "https://myfans.jp/public_creator", text: "Public Creator" }] },
    { rank: 2, links: [{ href: "https://myfans.jp/unlimited", text: "Unlimited" }] },
    { rank: 3, links: [{ href: "https://myfans.jp/plain_navigation", text: "" }] },
    { rank: null, links: [{ href: "https://myfans.jp/marketing", text: "Marketing" }] },
  ];
  const candidates = discoverCreatorCandidatesFromRanking("<html></html>", rankingUrl, { renderedUnits: units });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].candidate_slug, "public_creator");
  assert.equal(candidates[0].ranking_position, 1);
  assert.deepEqual(candidates[0].positive_discovery_evidence, ["RANKING_CREATOR_ITEM_RENDERED_STRUCTURAL_UNIT"]);
});

test("Safari fallback is explicit opt-in and raw mode remains the default", async () => {
  const source = await readFile(new URL("../scripts/myfans-public-pilot.mjs", import.meta.url), "utf8");
  assert.match(source, /args\["render-mode"\] \?\? "off"/);
  assert.match(source, /renderMode === SAFARI_RENDER_MODE/);
  assert.match(source, /createPublicHtmlFetcher/);
});

test("Safari renderer contains no certificate bypass, auth extraction, or cookie export path", async () => {
  const source = await readFile(new URL("../scripts/lib/myfans-safari-renderer.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /acceptInsecureCerts\s*:\s*true/);
  assert.doesNotMatch(source, /ignore-certificate|setAllowsAnyHTTPSCertificate|\/cookie\b|localStorage|sessionStorage/i);
  assert.doesNotMatch(source, /safaridriver[^\n]+--enable/);
});
