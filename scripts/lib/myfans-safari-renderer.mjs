import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import net from "node:net";
import process from "node:process";
import {
  canonicalizeMyFansRequestUrl,
  creatorSlugFromUrl,
  postIdFromUrl,
} from "./myfans-public-metadata.mjs";

export const SAFARI_RENDER_MODE = "safari-webdriver";
export const SAFARIDRIVER_PATH = "/usr/bin/safaridriver";

function codedError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function assertLocalWebDriverBaseUrl(value) {
  const url = new URL(String(value));
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.pathname !== "/") {
    throw codedError("NON_LOCAL_WEBDRIVER_ENDPOINT");
  }
  return url.toString().replace(/\/$/, "");
}

export function validateSafariRenderUrl(value, { allowLocalSelfTest = false } = {}) {
  const raw = String(value);
  if (allowLocalSelfTest && raw.startsWith("data:text/html,")) return raw;
  const requestUrl = canonicalizeMyFansRequestUrl(raw);
  if (requestUrl) {
    const url = new URL(requestUrl);
    const approvedRanking = /^\/ranking\/(?:creators|posts)\/all$/.test(url.pathname) && url.search === "?term=daily";
    const approvedCreator = Boolean(creatorSlugFromUrl(requestUrl));
    const approvedPost = Boolean(postIdFromUrl(requestUrl));
    if (approvedRanking || approvedCreator || approvedPost) return requestUrl;
  }
  if (raw === "https://example.com/") return raw;
  throw codedError("SAFARI_NAVIGATION_URL_REJECTED");
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
  if (!port) throw codedError("LOCAL_WEBDRIVER_PORT_UNAVAILABLE");
  return port;
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

const DOCUMENT_OBSERVATION_SCRIPT = `
  const href = location.href;
  const title = document.title || "";
  const readyState = document.readyState;
  const domLength = document.documentElement?.outerHTML?.length || 0;
  const text = document.body?.innerText || "";
  const textLength = text.length;
  const combined = title + "\\n" + text.slice(0, 20000);
  const errorPage = /(?:Safari Can.t Open the Page|ページを開けません|cannot establish a secure connection|安全な接続を確立できません)/i.test(combined);
  const certificateWarning = /(?:certificate.{0,40}(?:invalid|warning|expired)|証明書.{0,40}(?:無効|警告|期限)|connection is not private|接続はプライベートではありません)/i.test(combined);
  const challenge = /(?:captcha|verify you are human|checking your browser|just a moment|cloudflare|アクセスが制限されています)/i.test(combined);
  const authWall = /(?:(?:login|sign in|ログイン|サインイン).{0,80}(?:required|必要|してください)|(?:required|必要).{0,80}(?:login|sign in|ログイン|サインイン))/i.test(combined);
  const ageWall = /(?:18歳.{0,80}(?:確認|同意|入場|閲覧)|年齢.{0,60}(?:確認|認証)|age.{0,40}(?:verification|confirmation|gate))/i.test(combined);
  const authenticatedSessionPresent = /(?:ログアウト|サインアウト|マイページ|アカウント設定|dashboard)/i.test(text);
  const rankingRelated = /(?:ranking|ランキング|creator|クリエイター)/i.test(combined);
  const structuralUnits = [];
  for (const element of document.querySelectorAll("li, article, [class*='rank'], [data-testid*='rank']")) {
    const unitText = (element.innerText || "").replace(/\\s+/g, " ").trim();
    if (!unitText || unitText.length > 1500) continue;
    const rankMatch = unitText.match(/(?:^|\\s|#)([1-9]\\d{0,2})(?:位|\\s|$)/);
    if (!rankMatch) continue;
    const links = [...element.querySelectorAll("a[href]")].slice(0, 12).map((anchor) => ({
      href: anchor.href,
      text: (anchor.innerText || anchor.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim().slice(0, 160),
      rel: anchor.getAttribute("rel"),
      dataCreatorId: anchor.getAttribute("data-creator-id"),
      dataEntityType: anchor.getAttribute("data-entity-type") || anchor.getAttribute("data-type") || anchor.getAttribute("data-kind"),
      dataTestId: anchor.getAttribute("data-testid"),
    }));
    if (!links.length) continue;
    structuralUnits.push({
      rank: Number(rankMatch[1]),
      unitTag: element.tagName.toLowerCase(),
      unitClass: String(element.className || "").replace(/\\s+/g, " ").trim().slice(0, 240) || null,
      unitTestId: element.getAttribute("data-testid"),
      links,
    });
    if (structuralUnits.length >= 50) break;
  }
  return { href, title, readyState, domLength, textLength, errorPage, certificateWarning, challenge, authWall, ageWall, authenticatedSessionPresent, rankingRelated, structuralUnits };
`;

function expectedLocation(requestedUrl, observedUrl) {
  if (requestedUrl.startsWith("data:text/html,")) return observedUrl.startsWith("data:text/html,");
  try {
    const requested = new URL(requestedUrl);
    const observed = new URL(observedUrl);
    return requested.origin === observed.origin && requested.pathname === observed.pathname;
  } catch {
    return false;
  }
}

function documentUsable(requestedUrl, observation) {
  if (!observation || !expectedLocation(requestedUrl, observation.href)) return false;
  if (!observation.title || observation.domLength <= 0 || observation.textLength <= 0) return false;
  if (observation.errorPage || observation.certificateWarning || observation.challenge || observation.authWall || observation.ageWall || observation.authenticatedSessionPresent) return false;
  const requested = requestedUrl.startsWith("data:") ? null : new URL(requestedUrl);
  return requested?.pathname.startsWith("/ranking/") ? observation.rankingRelated : true;
}

export function createSafariWebDriverRenderer({
  driverPath = SAFARIDRIVER_PATH,
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
  accessImpl = access,
  reservePortImpl = reserveLoopbackPort,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  processAliveImpl = processAlive,
  maxNavigations = 40,
  maxWaitMs = 15_000,
  commandTimeoutMs = 5_000,
  maxHtmlBytes = 2_000_000,
} = {}) {
  if (typeof fetchImpl !== "function") throw codedError("FETCH_IMPLEMENTATION_REQUIRED");
  if (!Number.isInteger(maxNavigations) || maxNavigations < 1 || maxNavigations > 40) throw codedError("SAFARI_NAVIGATION_BUDGET_INVALID");
  if (!Number.isInteger(maxWaitMs) || maxWaitMs < 1 || maxWaitMs > 15_000) throw codedError("SAFARI_WAIT_BOUND_INVALID");
  if (!Number.isInteger(maxHtmlBytes) || maxHtmlBytes < 1 || maxHtmlBytes > 5_000_000) throw codedError("SAFARI_HTML_SIZE_LIMIT_INVALID");
  const requestedUrls = new Set();
  const requests = [];
  let child = null;
  let sessionId = null;
  let baseUrl = null;
  let capabilities = null;
  let started = false;
  let closed = false;
  let driverExit = null;
  let listenerActive = false;
  let stderr = "";

  async function httpRequest(pathname, { method = "GET", body, timeoutMs = commandTimeoutMs } = {}) {
    const response = await fetchImpl(`${baseUrl}${pathname}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json();
    if (!response.ok || payload.value?.error) {
      throw codedError(payload.value?.error ?? `WEBDRIVER_HTTP_${response.status}`, payload.value?.message ?? `WEBDRIVER_HTTP_${response.status}`);
    }
    return payload.value;
  }

  async function waitForDriver() {
    const deadline = Date.now() + 5_000;
    let lastError;
    while (Date.now() < deadline) {
      try {
        const status = await httpRequest("/status", { timeoutMs: 500 });
        if (status?.ready !== false) {
          listenerActive = true;
          return;
        }
      } catch (error) {
        lastError = error;
      }
      await sleepImpl(100);
    }
    throw codedError("SAFARIDRIVER_START_TIMEOUT", lastError?.message);
  }

  async function start() {
    if (started) return { base_url: baseUrl, capabilities };
    if (closed) throw codedError("SAFARI_RENDERER_ALREADY_CLOSED");
    try {
      await accessImpl(driverPath, constants.X_OK);
    } catch {
      throw codedError("SAFARIDRIVER_UNAVAILABLE");
    }
    const port = await reservePortImpl();
    baseUrl = assertLocalWebDriverBaseUrl(`http://127.0.0.1:${port}/`);
    child = spawnImpl(driverPath, ["-p", String(port)], { stdio: ["ignore", "ignore", "pipe"] });
    if (!child?.pid) throw codedError("SAFARIDRIVER_SPAWN_FAILED");
    child.once?.("exit", (code, signal) => {
      driverExit = { code, signal, at: new Date().toISOString() };
    });
    child.stderr?.on?.("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8_000);
    });
    try {
      await waitForDriver();
      const created = await httpRequest("/session", {
        method: "POST",
        body: {
          capabilities: {
            alwaysMatch: {
              browserName: "safari",
              acceptInsecureCerts: false,
              "safari:automaticInspection": false,
              "safari:automaticProfiling": false,
            },
          },
        },
        timeoutMs: 15_000,
      });
      sessionId = created?.sessionId;
      capabilities = created?.capabilities ?? {};
      if (!sessionId) throw codedError("SAFARI_SESSION_NOT_CREATED");
      if (capabilities.acceptInsecureCerts === true) throw codedError("CERTIFICATE_BYPASS_REFUSED");
      await httpRequest(`/session/${sessionId}/timeouts`, {
        method: "POST",
        body: { pageLoad: Math.min(12_000, maxWaitMs), script: commandTimeoutMs, implicit: 0 },
      });
      started = true;
      return { base_url: baseUrl, capabilities };
    } catch (error) {
      await close();
      throw error;
    }
  }

  async function observe() {
    return httpRequest(`/session/${sessionId}/execute/sync`, {
      method: "POST",
      body: { script: DOCUMENT_OBSERVATION_SCRIPT, args: [] },
    });
  }

  async function render(value, { label = null, allowLocalSelfTest = false } = {}) {
    if (!started || !sessionId || closed) throw codedError("SAFARI_RENDERER_NOT_ACTIVE");
    const url = validateSafariRenderUrl(value, { allowLocalSelfTest });
    if (requestedUrls.has(url)) throw codedError(`DUPLICATE_REQUEST_URL_BLOCKED:${url}`);
    if (requests.length >= maxNavigations) throw codedError("SAFARI_NAVIGATION_BUDGET_EXCEEDED");
    requestedUrls.add(url);
    const startedAt = new Date().toISOString();
    const deadline = Date.now() + maxWaitMs;
    let navigateError = null;
    try {
      await httpRequest(`/session/${sessionId}/url`, {
        method: "POST",
        body: { url },
        timeoutMs: Math.min(maxWaitMs, 13_000),
      });
    } catch (error) {
      navigateError = { code: error.code ?? error.name, message: String(error.message).slice(0, 300) };
    }
    let observation = null;
    let observeError = null;
    do {
      try {
        observation = await observe();
        observeError = null;
      } catch (error) {
        observeError = { code: error.code ?? error.name, message: String(error.message).slice(0, 300) };
      }
      if (observation?.authenticatedSessionPresent) throw codedError("AUTH_SESSION_PRESENT");
      if (observation?.certificateWarning) throw codedError("SAFARI_CERTIFICATE_WARNING");
      if (documentUsable(url, observation)) break;
      if (Date.now() < deadline) await sleepImpl(500);
    } while (Date.now() < deadline);
    if (!documentUsable(url, observation)) {
      const detail = navigateError?.code ?? observeError?.code ?? "NO_USABLE_DOCUMENT";
      throw codedError("SAFARI_RENDER_TIMEOUT", `SAFARI_RENDER_TIMEOUT:${detail}`);
    }
    const html = await httpRequest(`/session/${sessionId}/source`, { timeoutMs: commandTimeoutMs });
    if (typeof html !== "string" || html.length === 0) throw codedError("SAFARI_EMPTY_PAGE_SOURCE");
    if (Buffer.byteLength(html, "utf8") > maxHtmlBytes) throw codedError("SAFARI_HTML_RESPONSE_TOO_LARGE");
    const endedAt = new Date().toISOString();
    const safeObservation = {
      href: observation.href.startsWith("data:text/html,") ? "data:text/html,[synthetic-self-test-redacted]" : observation.href,
      title: observation.title,
      ready_state: observation.readyState,
      dom_length: observation.domLength,
      text_length: observation.textLength,
      ranking_related: observation.rankingRelated,
      structural_unit_count: observation.structuralUnits.length,
      certificate_warning: false,
      auth_wall: false,
      age_wall: false,
      challenge: false,
      authenticated_session_present: false,
    };
    requests.push({
      url: url.startsWith("data:") ? "data:text/html,[synthetic-self-test-redacted]" : url,
      label,
      started_at: startedAt,
      ended_at: endedAt,
      elapsed_sec: Number(((Date.parse(endedAt) - Date.parse(startedAt)) / 1000).toFixed(3)),
      title: safeObservation.title,
      dom_length: safeObservation.dom_length,
      text_length: safeObservation.text_length,
      page_source_length: html.length,
    });
    return {
      url,
      response_url: observation.href,
      status: 200,
      content_type: "text/html",
      location: null,
      html,
      rendered_units: observation.structuralUnits,
      render_observation: safeObservation,
      fetched_at: endedAt,
      transport: "SAFARI_RENDERED_PUBLIC_DOM",
    };
  }

  async function close() {
    if (closed) return summary();
    closed = true;
    if (sessionId && baseUrl) {
      try {
        await httpRequest(`/session/${sessionId}`, { method: "DELETE", timeoutMs: commandTimeoutMs });
      } catch {
        // The owned driver process is still terminated below if the session is unresponsive.
      }
    }
    sessionId = null;
    if (child && processAliveImpl(child.pid)) {
      child.kill("SIGTERM");
      const deadline = Date.now() + 3_000;
      while (processAliveImpl(child.pid) && Date.now() < deadline) await sleepImpl(50);
      if (processAliveImpl(child.pid)) child.kill("SIGKILL");
    }
    if (baseUrl) {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        try {
          await httpRequest("/status", { timeoutMs: 250 });
          listenerActive = true;
          await sleepImpl(50);
        } catch {
          listenerActive = false;
          break;
        }
      }
      if (listenerActive) throw codedError("SAFARIDRIVER_ORPHAN_LISTENER");
    }
    return summary();
  }

  function summary() {
    return {
      render_mode: SAFARI_RENDER_MODE,
      request_budget: maxNavigations,
      actual_requests: requests.length,
      initial_requests: requests.length,
      retry_requests: 0,
      unique_urls: requestedUrls.size,
      duplicate_requests: 0,
      image_body_gets: 0,
      video_gets: 0,
      authenticated_gets: 0,
      private_api_gets: 0,
      browser_generated_media_requests: "UNMEASURED_STANDARD_PAGE_RENDER",
      requests: requests.map(({ url, label, elapsed_sec, title, dom_length, text_length, page_source_length }) => ({ url, label, attempt: 0, status: 200, content_type: "text/html", elapsed_sec, title, dom_length, text_length, page_source_length })),
      driver: {
        path: driverPath,
        base_url: baseUrl,
        pid: child?.pid ?? null,
        exited: driverExit !== null || (child ? !processAliveImpl(child.pid) : true),
        exit: driverExit,
        stderr_line_count: stderr ? stderr.split(/\r?\n/).filter(Boolean).length : 0,
      },
      cleanup: {
        closed,
        session_active: Boolean(sessionId),
        driver_process_alive: child ? processAliveImpl(child.pid) : false,
        driver_listener_active: listenerActive,
      },
    };
  }

  return { start, render, close, summary };
}
