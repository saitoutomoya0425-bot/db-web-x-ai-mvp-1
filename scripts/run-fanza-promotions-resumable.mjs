import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import {
  runPromotionQueue,
  validatePromotionInput,
} from "./lib/fanza-promotion-runner.mjs";
import {
  normalizeTargetBaseUrl,
  prepareProductionAccess,
} from "./lib/production-access-guard.mjs";

const execFileAsync = promisify(execFile);
const processStartedAt = performance.now();
const values = new Map();
for (const argument of process.argv.slice(2)) {
  if (argument === "--write" || argument === "--dry-run" || argument === "--reconcile-only") {
    values.set(argument.slice(2), true);
  } else if (argument.startsWith("--") && argument.includes("=")) {
    const [name, ...value] = argument.slice(2).split("=");
    values.set(name, value.join("="));
  } else {
    throw new Error(`UNKNOWN_ARGUMENT_${argument}`);
  }
}

const selectedModes = ["write", "dry-run", "reconcile-only"].filter((mode) => values.get(mode) === true);
if (selectedModes.length !== 1) throw new Error("EXACTLY_ONE_MODE_REQUIRED");
const mode = selectedModes[0];
const sourceIdsFile = String(values.get("source-ids-file") ?? "");
const frontierTargetsFile = String(values.get("frontier-targets-file") ?? "");
const frontierSummaryFile = String(values.get("frontier-summary-file") ?? "");
const checkpointPath = String(values.get("state-path") ?? "");
const expectedCount = Number(values.get("expected-count"));
const expectedFrontierMembershipSha256 = String(values.get("expected-frontier-membership-sha256") ?? "");
const concurrency = Number(values.get("concurrency") ?? 1);
const requestTimeoutMs = Number(values.get("request-timeout-ms") ?? 120_000);
const settleChecks = Number(values.get("settle-checks") ?? 2);
const settleDelayMs = Number(values.get("settle-delay-ms") ?? 30_000);
const progressEvery = Number(values.get("progress-every") ?? 25);
if (Boolean(sourceIdsFile) === Boolean(frontierTargetsFile)) {
  throw new Error("EXACTLY_ONE_SOURCE_OR_FRONTIER_INPUT_REQUIRED");
}
if (sourceIdsFile && !path.isAbsolute(sourceIdsFile)) throw new Error("ABSOLUTE_SOURCE_IDS_FILE_REQUIRED");
if (frontierTargetsFile && !path.isAbsolute(frontierTargetsFile)) throw new Error("ABSOLUTE_FRONTIER_TARGETS_FILE_REQUIRED");
if (frontierTargetsFile && (!frontierSummaryFile || !path.isAbsolute(frontierSummaryFile))) {
  throw new Error("ABSOLUTE_FRONTIER_SUMMARY_FILE_REQUIRED");
}
if (!checkpointPath || !path.isAbsolute(checkpointPath)) throw new Error("ABSOLUTE_STATE_PATH_REQUIRED");
if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 1000) {
  throw new Error("EXPECTED_COUNT_1_TO_1000_REQUIRED");
}
if (![1, 2].includes(concurrency)) throw new Error("CONCURRENCY_1_OR_2_REQUIRED");
if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1000 || requestTimeoutMs > 300_000) {
  throw new Error("REQUEST_TIMEOUT_MS_1000_TO_300000_REQUIRED");
}
if (!Number.isInteger(settleDelayMs) || settleDelayMs < 0 || settleDelayMs > 600_000) {
  throw new Error("SETTLE_DELAY_MS_0_TO_600000_REQUIRED");
}

for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
  if (!process.env[key]?.trim()) throw new Error(`${key} is required`);
}

if (mode === "write") {
  // Fail before authentication, source inspection or mutation when local acceptance is invalid.
  try {
    await execFileAsync(process.execPath, ["scripts/validate-thumbnail-gold-labels.mjs"], {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024,
    });
  } catch {
    throw new Error("GOLD_LABEL_ACCEPTANCE_FAILED");
  }
}

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const { data: fanzaDataSource, error: fanzaDataSourceError } = await admin
  .from("data_sources").select("id").eq("name", "FANZA Webサービス").single();
if (fanzaDataSourceError || !fanzaDataSource) throw new Error("FANZA_DATA_SOURCE_NOT_FOUND");

async function loadFrontierInput() {
  if (path.dirname(frontierTargetsFile) !== path.dirname(frontierSummaryFile)) {
    throw new Error("FOREIGN_FRONTIER_PATH_MISMATCH");
  }
  const [targets, summary] = await Promise.all([
    JSON.parse(await readFile(frontierTargetsFile, "utf8")),
    JSON.parse(await readFile(frontierSummaryFile, "utf8")),
  ]);
  if (!Array.isArray(targets) || targets.some((value) => typeof value !== "string" || !value.trim())) {
    throw new Error("FRONTIER_TARGET_ARRAY_REQUIRED");
  }
  if (targets.length !== expectedCount) throw new Error(`FRONTIER_TARGET_COUNT_MISMATCH_${targets.length}`);
  if (new Set(targets).size !== targets.length) throw new Error("FRONTIER_TARGET_DUPLICATE");
  if (
    !["FROZEN", "PROCESSING", "COMPLETE"].includes(summary?.status) ||
    summary.membership_sha256 !== expectedFrontierMembershipSha256 ||
    Number(summary.classifications?.SAFE_NEW) !== expectedCount
  ) {
    throw new Error("FOREIGN_FRONTIER_SUMMARY_MISMATCH");
  }
  const rows = [];
  for (let index = 0; index < targets.length; index += 100) {
    const chunk = targets.slice(index, index + 100);
    const { data, error } = await admin
      .from("source_products")
      .select("id,external_product_id,normalized_product_code")
      .eq("data_source_id", fanzaDataSource.id)
      .in("external_product_id", chunk);
    if (error) throw new Error(`FRONTIER_SOURCE_LOOKUP_FAILED_${error.code ?? "UNKNOWN"}`);
    rows.push(...(data ?? []));
  }
  const returnedExternalIds = new Set(rows.map((row) => row.external_product_id));
  if (
    rows.length !== expectedCount ||
    new Set(rows.map((row) => row.id)).size !== expectedCount ||
    returnedExternalIds.size !== expectedCount ||
    targets.some((externalProductId) => !returnedExternalIds.has(externalProductId))
  ) {
    throw new Error(`UNKNOWN_FRONTIER_SOURCE_COUNT_${rows.length}_${expectedCount}`);
  }
  return {
    frontier_membership_sha256: expectedFrontierMembershipSha256,
    sources: rows.map((row) => ({
      source_id: row.id,
      product_code: row.normalized_product_code,
      external_product_id: row.external_product_id,
      frontier_membership_sha256: expectedFrontierMembershipSha256,
    })),
  };
}

const inputPayload = sourceIdsFile
  ? JSON.parse(await readFile(sourceIdsFile, "utf8"))
  : await loadFrontierInput();
const input = validatePromotionInput(inputPayload, {
  expectedCount,
  expectedFrontierMembershipSha256,
});

async function inspectSources(sourceIds) {
  const rows = [];
  for (let index = 0; index < sourceIds.length; index += 100) {
    const chunk = sourceIds.slice(index, index + 100);
    const { data, error } = await admin
      .from("source_products")
      .select("id,external_product_id,normalized_product_code,review_status,preview_status,promoted_video_id")
      .eq("data_source_id", fanzaDataSource.id)
      .in("id", chunk);
    if (error) throw new Error(`SOURCE_INSPECTION_FAILED_${error.code ?? "UNKNOWN"}`);
    rows.push(...(data ?? []));
  }
  return rows;
}

let mutateSource = async () => {
  throw new Error("MUTATION_DISABLED");
};
let access = null;
if (mode === "write") {
  if (process.env.PRODUCTION_ACCESS_CONFIRMED !== "true") {
    throw new Error("PRODUCTION_ACCESS_REQUIRES_CONFIRMATION");
  }
  for (const key of ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "ADMIN_EMAIL", "ADMIN_PASSWORD"]) {
    if (!process.env[key]?.trim()) throw new Error(`${key} is required`);
  }

  let cookies = [];
  const auth = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll: () => cookies,
        setAll: (updates) => {
          for (const update of updates) {
            cookies = cookies.filter((cookie) => cookie.name !== update.name);
            cookies.push({ name: update.name, value: update.value });
          }
        },
      },
    },
  );
  const login = await auth.auth.signInWithPassword({
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
  });
  if (login.error || login.data.user?.app_metadata?.role !== "admin") {
    throw new Error("ADMIN_AUTHENTICATION_FAILED");
  }

  const cookieHeader = cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
  const site = normalizeTargetBaseUrl(
    process.env.PROMOTE_SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000",
  );
  const requests = input.map((source) => ({
    method: "POST",
    url: `${site}/api/admin/fanza/promote?source_id=${encodeURIComponent(source.source_id)}`,
    label: `promote ${source.product_code}`,
  }));
  access = await prepareProductionAccess({
    name: `fanza-promotion-${expectedFrontierMembershipSha256.slice(0, 12)}`,
    requests,
    maxRequests: expectedCount,
    maxConcurrency: concurrency,
    maxRetries: 0,
  });
  if (access.dryRun) throw new Error("WRITE_MODE_CANNOT_USE_DRY_RUN_ACCESS_GUARD");
  const requestById = new Map(input.map((source, index) => [source.source_id, requests[index]]));

  mutateSource = async (source) => {
    const request = requestById.get(source.source_id);
    if (!request) throw new Error(`INPUT_OUTSIDE_MUTATION_BLOCKED_${source.source_id}`);
    let response;
    try {
      response = await fetch(request.url, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cookieHeader },
        body: JSON.stringify({ ids: [source.source_id] }),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (cause) {
      if (cause?.name === "AbortError" || cause?.name === "TimeoutError" || cause?.cause?.code === "UND_ERR_CONNECT_TIMEOUT") {
        const error = new Error("PROMOTE_TIMEOUT");
        error.code = "PROMOTE_TIMEOUT";
        throw error;
      }
      const error = new Error("PROMOTE_TRANSPORT_FAILED");
      error.code = "PROMOTE_TRANSPORT_FAILED";
      throw error;
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok && response.status !== 207) {
      return { status: "failed", error_code: `PROMOTE_HTTP_${response.status}` };
    }
    if (Number(body.promoted) === 1 && (!Array.isArray(body.errors) || body.errors.length === 0)) {
      return { status: "confirmed" };
    }
    return { status: "failed", error_code: "PROMOTE_RESPONSE_NOT_CONFIRMED" };
  };
}

const processStartupMs = performance.now() - processStartedAt;
const result = await runPromotionQueue({
  input,
  frontierMembershipSha256: expectedFrontierMembershipSha256,
  checkpointPath,
  inspectSources,
  mutateSource,
  mode,
  concurrency,
  settleChecks,
  settleDelayMs,
  progressEvery,
});
const completionPath = access
  ? await access.writeCompletion({
      actualRequestCount: result.network_requests_this_run,
      expected_count: expectedCount,
      completed: result.completed,
      timeouts: result.timeouts,
      settles: result.settles,
      unresolved: result.counts.UNRESOLVED,
      failed: result.counts.FAILED,
      duplicate_mutations: result.duplicate_mutations,
      blind_retries: result.blind_retries,
    })
  : null;

console.log(JSON.stringify({
  ...result,
  process_startup_ms: processStartupMs,
  process_total_elapsed_ms: performance.now() - processStartedAt,
  source_ids_file: sourceIdsFile || null,
  frontier_targets_file: frontierTargetsFile || null,
  frontier_summary_file: frontierSummaryFile || null,
  state_path: checkpointPath,
  completion_path: completionPath,
  default_concurrency: 1,
  configured_concurrency: concurrency,
  one_source_per_request: true,
  secrets_exposed: false,
}, null, 2));

if (mode === "write" && (result.counts.UNRESOLVED || result.counts.FAILED)) {
  process.exitCode = 1;
}
