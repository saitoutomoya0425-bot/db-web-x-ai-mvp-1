import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import {
  canonicalizeMyFansRequestUrl,
  creatorSlugFromUrl,
  postIdFromUrl,
} from "./myfans-public-metadata.mjs";

const execFileAsync = promisify(execFile);

export const MODERN_BROWSER_SOURCE_TYPE = "MODERN_BROWSER_RENDERED_PUBLIC_DOM";
export const MODERN_CHROME_MIN_MAJOR = 100;
export const CHROME_PATH_CANDIDATES = Object.freeze([
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
]);

const BLOCKED_MEDIA_PATTERNS = Object.freeze([
  "*.avif", "*.gif", "*.ico", "*.jpeg", "*.jpg", "*.png", "*.svg", "*.webp",
  "*.aac", "*.flac", "*.m3u8", "*.m4a", "*.mov", "*.mp3", "*.mp4", "*.ogg", "*.wav", "*.webm",
]);

function codedError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!port) throw codedError("LOCAL_CDP_PORT_UNAVAILABLE");
  return port;
}

async function readOsRelease() {
  try {
    const text = await readFile("/etc/os-release", "utf8");
    return Object.fromEntries(text.split("\n").map((line) => line.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean)
      .map((match) => [match[1].toLowerCase(), match[2].replace(/^"|"$/g, "")]));
  } catch {
    return {};
  }
}

export function chromeMajorFromVersion(value) {
  const match = String(value ?? "").match(/(?:Chrome|Chromium)\s+(\d+)(?:\.|\s|$)/i);
  return match ? Number(match[1]) : null;
}

export async function probeModernBrowserEnvironment({
  candidates = CHROME_PATH_CANDIDATES,
  accessImpl = access,
  versionImpl = async (browserPath) => (await execFileAsync(browserPath, ["--version"], { timeout: 5_000 })).stdout.trim(),
  osReleaseImpl = readOsRelease,
} = {}) {
  const environment = {
    generated_at: new Date().toISOString(),
    runner_os: process.env.RUNNER_OS ?? os.type(),
    os_release: await osReleaseImpl(),
    architecture: os.arch(),
    node_version: process.version,
    browser_path: null,
    browser_version: null,
    browser_major: null,
    modern_browser_available: false,
    minimum_compatibility_major: MODERN_CHROME_MIN_MAJOR,
    new_browser_install: 0,
    browser_download: 0,
  };
  for (const browserPath of candidates) {
    try {
      await accessImpl(browserPath, constants.X_OK);
      const version = await versionImpl(browserPath);
      const major = chromeMajorFromVersion(version);
      environment.browser_path = browserPath;
      environment.browser_version = version;
      environment.browser_major = major;
      environment.modern_browser_available = Number.isInteger(major) && major >= MODERN_CHROME_MIN_MAJOR;
      environment.availability_reason = environment.modern_browser_available
        ? "PREINSTALLED_MODERN_CHROME_CONFIRMED"
        : "BROWSER_VERSION_BELOW_COMPATIBILITY_FLOOR";
      return environment;
    } catch {
      // The next fixed preinstalled path is checked without installing anything.
    }
  }
  environment.availability_reason = "PREINSTALLED_CHROME_NOT_FOUND";
  return environment;
}

export function validateModernBrowserUrl(value) {
  const raw = String(value);
  if (raw === "https://example.com/") return raw;
  const requestUrl = canonicalizeMyFansRequestUrl(raw);
  if (!requestUrl) throw codedError("MODERN_BROWSER_URL_REJECTED");
  const url = new URL(requestUrl);
  const approvedRanking = /^\/ranking\/(?:creators|posts)\/all$/.test(url.pathname) && url.search === "?term=daily";
  if (approvedRanking || creatorSlugFromUrl(requestUrl) || postIdFromUrl(requestUrl)) return requestUrl;
  throw codedError("MODERN_BROWSER_URL_REJECTED");
}

function assertLocalWebSocketUrl(value, port) {
  const url = new URL(String(value));
  if (url.protocol !== "ws:" || !["127.0.0.1", "localhost"].includes(url.hostname) || Number(url.port) !== port || url.username || url.password) {
    throw codedError("NON_LOCAL_CDP_ENDPOINT");
  }
  return url.toString();
}

export async function connectCdp(webSocketUrl, { WebSocketImpl = globalThis.WebSocket, timeoutMs = 5_000 } = {}) {
  if (typeof WebSocketImpl !== "function") throw codedError("NODE_WEBSOCKET_UNAVAILABLE");
  const socket = new WebSocketImpl(webSocketUrl);
  const pending = new Map();
  const listeners = new Map();
  let nextId = 1;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(codedError("CDP_CONNECT_TIMEOUT")), timeoutMs);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(codedError("CDP_CONNECT_FAILED"));
    }, { once: true });
  });
  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.id) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(codedError("CDP_COMMAND_FAILED", message.error.message));
      else entry.resolve(message.result ?? {});
      return;
    }
    for (const listener of listeners.get(message.method) ?? []) listener(message.params ?? {}, message.sessionId ?? null);
  });
  socket.addEventListener("close", () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(codedError("CDP_CONNECTION_CLOSED"));
    }
    pending.clear();
  });
  return {
    send(method, params = {}, sessionId = null) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(codedError("CDP_COMMAND_TIMEOUT", method));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    on(method, listener) {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method).add(listener);
      return () => listeners.get(method)?.delete(listener);
    },
    close() {
      if (socket.readyState < 2) socket.close();
    },
  };
}

async function discoverCdpEndpoint(port, fetchImpl) {
  const deadline = Date.now() + 7_500;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        const value = await response.json();
        return assertLocalWebSocketUrl(value.webSocketDebuggerUrl, port);
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw codedError("MODERN_BROWSER_START_TIMEOUT", lastError?.message);
}

const DOCUMENT_OBSERVATION_SCRIPT = `(() => {
  const href = location.href;
  const title = document.title || "";
  const readyState = document.readyState;
  const domLength = document.documentElement?.outerHTML?.length || 0;
  const text = document.body?.innerText || "";
  const textLength = text.length;
  const combined = title + "\\n" + text.slice(0, 30000);
  const errorPage = /(?:ERR_[A-Z_]+|This site can.t be reached|Your connection is not private|このサイトにアクセスできません|接続はプライベートではありません)/i.test(combined);
  const certificateWarning = /(?:certificate.{0,40}(?:invalid|warning|expired)|証明書.{0,40}(?:無効|警告|期限)|connection is not private|接続はプライベートではありません)/i.test(combined);
  const challenge = /(?:captcha|verify you are human|checking your browser|just a moment|cloudflare|アクセスが制限されています)/i.test(combined);
  const authWall = /(?:(?:login|sign in|ログイン|サインイン).{0,80}(?:required|必要|してください)|(?:required|必要).{0,80}(?:login|sign in|ログイン|サインイン))/i.test(combined);
  const ageWall = /(?:18歳.{0,80}(?:確認|同意|入場|閲覧)|年齢.{0,60}(?:確認|認証)|age.{0,40}(?:verification|confirmation|gate))/i.test(combined);
  const authenticatedSessionPresent = /(?:ログアウト|サインアウト|アカウント設定|dashboard)/i.test(text);
  const rankingRelated = /(?:ranking|ランキング|creator|クリエイター)/i.test(combined);
  const rankLikeContent = /(?:^|\\s|#)[1-9]\\d{0,2}(?:位|\\s|$)/m.test(text);
  const structuralUnits = [];
  const selectors = "li, article, tr, [role='listitem'], [class*='rank'], [class*='Rank'], [class*='card'], [class*='Card'], [data-testid*='rank'], [data-testid*='creator']";
  for (const element of document.querySelectorAll(selectors)) {
    const unitText = (element.innerText || "").replace(/\\s+/g, " ").trim();
    if (!unitText || unitText.length > 2000) continue;
    const explicitRank = element.getAttribute("data-rank") || element.querySelector("[data-rank]")?.getAttribute("data-rank");
    const rankText = explicitRank || element.querySelector("[class*='rank'], [class*='Rank'], [data-testid*='rank']")?.textContent || unitText;
    const rankMatch = String(rankText).match(/(?:^|\\s|#)([1-9]\\d{0,2})(?:位|\\s|$)/);
    if (!rankMatch) continue;
    const links = [...element.querySelectorAll("a[href]")].slice(0, 12).map((anchor) => ({
      href: anchor.href,
      text: (anchor.innerText || anchor.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim().slice(0, 160),
    }));
    if (!links.length) continue;
    structuralUnits.push({ rank: Number(rankMatch[1]), links });
    if (structuralUnits.length >= 50) break;
  }
  return {
    href, title, readyState, domLength, textLength, errorPage, certificateWarning,
    challenge, authWall, ageWall, authenticatedSessionPresent, rankingRelated,
    rankLikeContent, anchorCount: document.querySelectorAll("a[href]").length,
    structuralUnits,
  };
})()`;

function expectedLocation(requestedUrl, observedUrl) {
  if (requestedUrl === "https://example.com/") return observedUrl === requestedUrl;
  return canonicalizeMyFansRequestUrl(observedUrl) === requestedUrl;
}

function documentUsable(requestedUrl, observation) {
  if (!observation || !expectedLocation(requestedUrl, observation.href)) return false;
  if (!observation.title || observation.domLength <= 0 || observation.textLength <= 0) return false;
  if (observation.errorPage || observation.certificateWarning || observation.challenge || observation.authWall || observation.ageWall || observation.authenticatedSessionPresent) return false;
  if (requestedUrl === "https://example.com/") return observation.title === "Example Domain";
  return new URL(requestedUrl).pathname.startsWith("/ranking/") ? observation.rankingRelated : true;
}

export function createModernBrowserRenderer({
  browser,
  spawnImpl = spawn,
  fetchImpl = globalThis.fetch,
  connectCdpImpl = connectCdp,
  discoverEndpointImpl = discoverCdpEndpoint,
  reservePortImpl = reserveLoopbackPort,
  mkdtempImpl = mkdtemp,
  rmImpl = rm,
  processAliveImpl = processAlive,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxNavigations = 38,
  maxWaitMs = 15_000,
  maxHtmlBytes = 2_000_000,
} = {}) {
  if (!browser?.path || !browser.modern_browser_available) throw codedError("MODERN_BROWSER_RUNNER_UNAVAILABLE");
  if (!Number.isInteger(maxNavigations) || maxNavigations < 1 || maxNavigations > 38) throw codedError("MODERN_BROWSER_NAVIGATION_BUDGET_INVALID");
  if (!Number.isInteger(maxWaitMs) || maxWaitMs < 1 || maxWaitMs > 15_000) throw codedError("MODERN_BROWSER_WAIT_BOUND_INVALID");
  const requestedUrls = new Set();
  const requests = [];
  const networkCounts = { Document: 0, Fetch: 0, XHR: 0, Image: 0, Media: 0, Font: 0, Other: 0 };
  let child = null;
  let profileDir = null;
  let port = null;
  let client = null;
  let browserContextId = null;
  let targetId = null;
  let sessionId = null;
  let started = false;
  let closed = false;
  let listenerActive = false;
  let stderrLineCount = 0;
  let documentStatus = null;
  let securityState = null;
  let lifecycleEvents = new Set();

  async function start() {
    if (started) return summary();
    if (closed) throw codedError("MODERN_BROWSER_ALREADY_CLOSED");
    try {
      profileDir = await mkdtempImpl(path.join(os.tmpdir(), "okazu-myfans-chrome-"));
      port = await reservePortImpl();
      const args = [
        "--headless=new",
        "--remote-debugging-address=127.0.0.1",
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--metrics-recording-only",
        "--autoplay-policy=user-gesture-required",
        "--blink-settings=imagesEnabled=false",
        "about:blank",
      ];
      child = spawnImpl(browser.path, args, { stdio: ["ignore", "ignore", "pipe"] });
      if (!child?.pid) throw codedError("MODERN_BROWSER_SPAWN_FAILED");
      child.stderr?.on?.("data", (chunk) => {
        stderrLineCount += chunk.toString().split(/\r?\n/).filter(Boolean).length;
      });
      const webSocketUrl = await discoverEndpointImpl(port, fetchImpl);
      assertLocalWebSocketUrl(webSocketUrl, port);
      listenerActive = true;
      client = await connectCdpImpl(webSocketUrl);
      ({ browserContextId } = await client.send("Target.createBrowserContext", { disposeOnDetach: true }));
      ({ targetId } = await client.send("Target.createTarget", { url: "about:blank", browserContextId }));
      ({ sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true }));
      if (!browserContextId || !targetId || !sessionId) throw codedError("MODERN_BROWSER_SESSION_NOT_CREATED");
      client.on("Network.requestWillBeSent", (params, eventSessionId) => {
        if (eventSessionId !== sessionId) return;
        const type = Object.hasOwn(networkCounts, params.type) ? params.type : "Other";
        networkCounts[type] += 1;
      });
      client.on("Network.responseReceived", (params, eventSessionId) => {
        if (eventSessionId === sessionId && params.type === "Document") documentStatus = params.response?.status ?? null;
      });
      client.on("Page.lifecycleEvent", (params, eventSessionId) => {
        if (eventSessionId === sessionId && params.name) lifecycleEvents.add(params.name);
      });
      client.on("Security.visibleSecurityStateChanged", (params, eventSessionId) => {
        if (eventSessionId === sessionId) securityState = params.visibleSecurityState?.securityState ?? null;
      });
      for (const method of ["Page.enable", "Runtime.enable", "Network.enable", "Security.enable"]) {
        await client.send(method, {}, sessionId);
      }
      await client.send("Page.setLifecycleEventsEnabled", { enabled: true }, sessionId);
      await client.send("Network.setBlockedURLs", { urls: BLOCKED_MEDIA_PATTERNS }, sessionId);
      await client.send("Browser.setDownloadBehavior", { behavior: "deny", browserContextId });
      started = true;
      return summary();
    } catch (error) {
      await close();
      throw error;
    }
  }

  async function evaluate(expression) {
    const result = await client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: false }, sessionId);
    if (result.exceptionDetails) throw codedError("MODERN_BROWSER_EVALUATION_FAILED");
    return result.result?.value;
  }

  async function render(value, { label = null } = {}) {
    if (!started || closed || !sessionId) throw codedError("MODERN_BROWSER_NOT_ACTIVE");
    const url = validateModernBrowserUrl(value);
    if (requestedUrls.has(url)) throw codedError(`DUPLICATE_REQUEST_URL_BLOCKED:${url}`);
    if (requests.length >= maxNavigations) throw codedError("MODERN_BROWSER_NAVIGATION_BUDGET_EXCEEDED");
    requestedUrls.add(url);
    const attemptRecord = { url, label, attempt: 0, status: null, error_code: null };
    requests.push(attemptRecord);
    documentStatus = null;
    securityState = null;
    lifecycleEvents = new Set();
    const startedAt = new Date().toISOString();
    const navigate = await client.send("Page.navigate", { url }, sessionId);
    if (/ERR_CERT_/i.test(navigate.errorText ?? "")) throw codedError("MODERN_BROWSER_CERTIFICATE_ERROR", navigate.errorText);
    const deadline = Date.now() + maxWaitMs;
    let observation = null;
    do {
      observation = await evaluate(DOCUMENT_OBSERVATION_SCRIPT);
      if (observation?.authenticatedSessionPresent) throw codedError("AUTH_SESSION_PRESENT");
      if (observation?.certificateWarning) throw codedError("MODERN_BROWSER_CERTIFICATE_ERROR");
      if (observation?.challenge) throw codedError("MODERN_BROWSER_CHALLENGE_BLOCKED");
      if (observation?.authWall || observation?.ageWall) throw codedError("MODERN_BROWSER_PROTECTED_INTERSTITIAL");
      if ([403, 429].includes(documentStatus)) throw codedError(`MODERN_BROWSER_HTTP_${documentStatus}`);
      if (documentUsable(url, observation)) break;
      if (Date.now() < deadline) await sleepImpl(500);
    } while (Date.now() < deadline);
    if (!documentUsable(url, observation)) throw codedError("MODERN_BROWSER_RENDER_TIMEOUT", navigate.errorText ?? "NO_USABLE_DOCUMENT");
    const html = await evaluate("document.documentElement?.outerHTML || ''");
    if (typeof html !== "string" || !html) throw codedError("MODERN_BROWSER_EMPTY_DOM");
    if (Buffer.byteLength(html, "utf8") > maxHtmlBytes) throw codedError("MODERN_BROWSER_DOM_TOO_LARGE");
    const endedAt = new Date().toISOString();
    const completedRequest = {
      url,
      label,
      attempt: 0,
      status: documentStatus ?? 200,
      started_at: startedAt,
      ended_at: endedAt,
      elapsed_sec: Number(((Date.parse(endedAt) - Date.parse(startedAt)) / 1000).toFixed(3)),
      title: observation.title,
      final_url: observation.href,
      dom_length: observation.domLength,
      text_length: observation.textLength,
      anchor_count: observation.anchorCount,
      structural_unit_count: observation.structuralUnits.length,
    };
    Object.assign(attemptRecord, completedRequest);
    return {
      url,
      response_url: observation.href,
      status: completedRequest.status,
      content_type: "text/html",
      location: null,
      html,
      rendered_units: observation.structuralUnits,
      render_observation: {
        href: observation.href,
        title: observation.title,
        ready_state: observation.readyState,
        dom_length: observation.domLength,
        text_length: observation.textLength,
        anchor_count: observation.anchorCount,
        ranking_related: observation.rankingRelated,
        rank_like_content: observation.rankLikeContent,
        structural_unit_count: observation.structuralUnits.length,
        lifecycle_events: [...lifecycleEvents].sort(),
        security_state: securityState,
        certificate_warning: false,
        authenticated_session_present: false,
        challenge: false,
      },
      fetched_at: endedAt,
      transport: MODERN_BROWSER_SOURCE_TYPE,
    };
  }

  function summary() {
    return {
      source_type: MODERN_BROWSER_SOURCE_TYPE,
      request_budget: maxNavigations,
      actual_requests: requests.length,
      retry_requests: 0,
      unique_urls: requestedUrls.size,
      duplicate_requests: 0,
      intentional_image_gets: 0,
      intentional_video_gets: 0,
      intentional_audio_gets: 0,
      private_api_gets: 0,
      authenticated_gets: 0,
      browser_generated_request_types: { ...networkCounts },
      requests: requests.map(({ started_at, ended_at, ...request }) => request),
      browser: {
        path: browser.path,
        version: browser.browser_version,
        major: browser.browser_major,
        preinstalled: true,
        new_install: 0,
        pid: child?.pid ?? null,
        stderr_line_count: stderrLineCount,
      },
      cleanup: {
        closed,
        session_active: Boolean(sessionId),
        browser_process_alive: child ? processAliveImpl(child.pid) : false,
        cdp_listener_active: listenerActive,
        temp_profile_present: Boolean(profileDir),
      },
    };
  }

  async function close() {
    if (closed) return summary();
    closed = true;
    if (client) {
      try {
        if (targetId) await client.send("Target.closeTarget", { targetId });
        if (browserContextId) await client.send("Target.disposeBrowserContext", { browserContextId });
        await client.send("Browser.close");
      } catch {
        // The owned browser process is terminated below if CDP is unresponsive.
      }
      client.close();
    }
    sessionId = null;
    targetId = null;
    browserContextId = null;
    if (child && processAliveImpl(child.pid)) {
      child.kill("SIGTERM");
      const deadline = Date.now() + 3_000;
      while (processAliveImpl(child.pid) && Date.now() < deadline) await sleepImpl(50);
      if (processAliveImpl(child.pid)) child.kill("SIGKILL");
    }
    if (port) {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        try {
          await fetchImpl(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(250) });
          listenerActive = true;
          await sleepImpl(50);
        } catch {
          listenerActive = false;
          break;
        }
      }
    }
    if (profileDir) {
      await rmImpl(profileDir, { recursive: true, force: true });
      profileDir = null;
    }
    if (listenerActive || (child && processAliveImpl(child.pid))) throw codedError("MODERN_BROWSER_ORPHANED");
    return summary();
  }

  return { start, render, close, summary };
}
