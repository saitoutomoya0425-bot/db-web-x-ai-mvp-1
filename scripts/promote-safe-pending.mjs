import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeTargetBaseUrl, prepareProductionAccess } from "./lib/production-access-guard.mjs";
import { fanzaSafetyReviewReasons } from "../src/lib/fanza/pipeline.ts";

const execFileAsync = promisify(execFile);

// Promotion is a write path. Never contact Supabase or the site before the
// reviewed thumbnail contract passes in the local offline acceptance gate.
try {
  await execFileAsync(process.execPath, ["scripts/validate-thumbnail-gold-labels.mjs"], {
    cwd: process.cwd(),
    maxBuffer: 1024 * 1024,
  });
} catch {
  throw new Error("GOLD_LABEL_ACCEPTANCE_FAILED: thumbnail promotion stopped before any DB or HTTP access");
}

const required = [
  "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY", "ADMIN_EMAIL", "ADMIN_PASSWORD",
];
for (const key of required) if (!process.env[key]?.trim()) throw new Error(`${key} is required`);

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
const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const { data: candidates, error: candidateError } = await admin.from("source_products")
  .select("id,normalized_data")
  .eq("preview_status", "new")
  .eq("review_status", "pending")
  .order("fetched_at", { ascending: process.env.PROMOTE_ORDER !== "desc" });
if (candidateError) throw new Error("CANDIDATE_LOOKUP_FAILED");

const safe = (candidates ?? []).filter(({ normalized_data: item }) =>
  item && fanzaSafetyReviewReasons(item).length === 0,
);
if (safe.length !== (candidates ?? []).length) throw new Error("UNSAFE_NEW_CANDIDATE_DETECTED");

const cookieHeader = cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
const site = normalizeTargetBaseUrl(process.env.PROMOTE_SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000");
let promoted = 0;
let failed = 0;
const batches = Array.from(
  { length: Math.ceil(safe.length / 5) },
  (_, index) => safe.slice(index * 5, index * 5 + 5),
);
const plannedRequests = batches.map((_, index) => ({
  method: "POST",
  url: `${site}/api/admin/fanza/promote?batch=${index + 1}`,
  label: `promote-safe batch ${index + 1}/${batches.length}`,
}));
const access = await prepareProductionAccess({
  name: "promote-safe-pending",
  requests: plannedRequests,
  maxRequests: 100,
  maxConcurrency: 2,
  maxRetries: 0,
});
if (access.dryRun) {
  const completionPath = await access.writeCompletion({
    skipped: true,
    reason: "DRY_RUN=true",
    total_candidates: safe.length,
    batch_count: batches.length,
    planned_post_count: plannedRequests.length,
  });
  console.log(JSON.stringify({
    dry_run: true,
    total_candidates: safe.length,
    batch_count: batches.length,
    planned_post_count: plannedRequests.length,
    planned_path: access.plannedPath,
    completion_path: completionPath,
    secrets_exposed: false,
  }, null, 2));
  process.exit(0);
}
let nextBatch = 0;
let actualRequestCount = 0;
async function worker() {
  while (nextBatch < batches.length) {
    const batchIndex = nextBatch++;
    const batch = batches[batchIndex];
  actualRequestCount += 1;
  const response = await fetch(plannedRequests[batchIndex].url, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: cookieHeader },
    body: JSON.stringify({ ids: batch.map(({ id }) => id) }),
    signal: AbortSignal.timeout(120_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok && response.status !== 207) throw new Error(`PROMOTE_HTTP_${response.status}`);
  promoted += Number(result.promoted ?? 0);
  failed += Array.isArray(result.errors) ? result.errors.length : 0;
    if ((batchIndex + 1) % 10 === 0 || batchIndex + 1 === batches.length) {
      console.log(JSON.stringify({
        batches_completed: batchIndex + 1,
        total_batches: batches.length,
        promoted,
        failed,
      }));
    }
  }
}
await Promise.all([worker(), worker()]);
const completionPath = await access.writeCompletion({
  actualRequestCount,
  total_candidates: safe.length,
  batch_count: batches.length,
  promoted,
  failed,
});
console.log(JSON.stringify({ total_candidates: safe.length, promoted, failed, actual_request_count: actualRequestCount, completion_path: completionPath, secrets_exposed: false }));
