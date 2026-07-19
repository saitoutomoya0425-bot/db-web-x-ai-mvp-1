import fs from "node:fs/promises";
import path from "node:path";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
const DEFAULT_REPORT_DIR = path.join(process.cwd(), "tmp", "production-access");

export function isDryRun() {
  return String(process.env.DRY_RUN ?? "").toLowerCase() === "true";
}

export function normalizeTargetBaseUrl(value, fallback = "http://localhost:3000") {
  const raw = String(value || fallback).trim();
  const url = new URL(raw);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function isProductionUrl(value) {
  const url = new URL(value);
  return url.protocol === "https:" && !LOCAL_HOSTS.has(url.hostname);
}

function requestKey(request) {
  return `${request.method ?? "GET"} ${request.url}`;
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function prepareProductionAccess({
  name,
  requests,
  maxRequests = 100,
  maxConcurrency = 3,
  maxRetries = 1,
  reportDir = DEFAULT_REPORT_DIR,
}) {
  if (!name) throw new Error("production access guard requires a name");
  if (!Array.isArray(requests)) throw new Error("production access guard requires requests[]");
  if (maxConcurrency > 3) throw new Error("PRODUCTION_ACCESS_CONCURRENCY_TOO_HIGH");
  if (maxRetries > 1) throw new Error("PRODUCTION_ACCESS_RETRY_TOO_HIGH");

  const planned = requests.map((request, index) => ({
    index: index + 1,
    method: request.method ?? "GET",
    url: request.url,
    label: request.label ?? null,
  }));
  const keys = planned.map(requestKey);
  const duplicates = [...new Set(keys.filter((key, index) => keys.indexOf(key) !== index))];
  const productionRequests = planned.filter((request) => isProductionUrl(request.url));
  const dryRun = isDryRun();
  const generatedAt = new Date().toISOString();
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "-");
  const plannedPath = path.join(reportDir, `${safeName}-planned-${Date.now()}.json`);
  const report = {
    generated_at: generatedAt,
    name,
    dry_run: dryRun,
    max_requests: maxRequests,
    max_concurrency: maxConcurrency,
    max_retries: maxRetries,
    planned_request_count: planned.length,
    production_request_count: productionRequests.length,
    duplicate_request_count: duplicates.length,
    duplicates,
    requests: planned,
  };
  await writeJson(plannedPath, report);

  console.log(JSON.stringify({
    production_access_guard: name,
    dry_run: dryRun,
    planned_request_count: planned.length,
    production_request_count: productionRequests.length,
    duplicate_request_count: duplicates.length,
    max_requests: maxRequests,
    max_concurrency: maxConcurrency,
    max_retries: maxRetries,
    planned_path: plannedPath,
  }, null, 2));

  if (duplicates.length) throw new Error(`DUPLICATE_REQUEST_URLS_BLOCKED: ${duplicates.slice(0, 5).join(", ")}`);
  if (planned.length > maxRequests) throw new Error(`PLANNED_REQUESTS_EXCEED_LIMIT: ${planned.length} > ${maxRequests}`);
  if (productionRequests.length && process.env.PRODUCTION_ACCESS_CONFIRMED !== "true") {
    throw new Error("PRODUCTION_ACCESS_REQUIRES_CONFIRMATION");
  }

  return {
    dryRun,
    plannedPath,
    planned,
    async writeCompletion(extra = {}) {
      const completionPath = path.join(reportDir, `${safeName}-completed-${Date.now()}.json`);
      await writeJson(completionPath, {
        ...report,
        completed_at: new Date().toISOString(),
        actual_request_count: extra.actualRequestCount ?? 0,
        ...extra,
      });
      return completionPath;
    },
  };
}
