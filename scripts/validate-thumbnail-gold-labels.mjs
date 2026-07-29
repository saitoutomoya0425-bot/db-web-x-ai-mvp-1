/**
 * Offline acceptance gate for thumbnail-policy v1.
 *
 * It validates the 72 reviewed labels against only the saved 1,000-work
 * snapshot and local image cache. It intentionally does not fetch, generate,
 * write public assets, connect to Supabase, or inspect production.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  assertGoldAcceptance,
  loadThumbnailGoldLabels,
  resolveGoldThumbnail,
} from "./lib/thumbnail-gold-acceptance.mjs";

const root = process.cwd();
const requestedCodes = new Set(
  (process.argv.find((arg) => arg.startsWith("--codes="))?.slice("--codes=".length) ?? "")
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean),
);
const outDir = path.join(
  root,
  "tmp",
  "card-thumbnail-reaudit",
  "gold-sync",
  requestedCodes.size ? "targeted" : "all-72",
);
const publicDir = path.join(root, "public", "card-thumbnails");
const cacheDirs = [
  path.join(root, "tmp", "card-thumbnail-v3-dry-run", "cache"),
  path.join(root, "tmp", "card-thumbnail-v2-dry-run", "cache"),
];
const snapshotPath = path.join(root, "tmp", "card-thumbnail-reaudit", "all-audit.csv");
const localOverridesPath = path.join(root, "data", "thumbnail-local-overrides.json");
const humanApprovalsPath = path.join(root, "data", "thumbnail-human-approvals.csv");

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { if (row.length || field) { pushField(); rows.push(row); } row = []; };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { field += '"'; index += 1; } else quoted = !quoted;
    } else if (char === "," && !quoted) pushField();
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      pushRow();
    } else field += char;
  }
  pushRow();
  const [header = [], ...body] = rows;
  return body.filter((values) => values.some((value) => value.trim()))
    .map((values) => Object.fromEntries(header.map((name, index) => [name.replace(/^\uFEFF/, ""), values[index] ?? ""])));
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function cachedPath(url) {
  if (!url) return null;
  if (url.startsWith("/card-thumbnails/")) {
    const file = path.join(publicDir, path.basename(url));
    return file;
  }
  if (!/^https:\/\//.test(url)) return null;
  const extension = path.extname(new URL(url).pathname) || ".jpg";
  const file = `${crypto.createHash("sha1").update(url).digest("hex")}${extension}`;
  return cacheDirs.map((dir) => path.join(dir, file));
}

async function hasCachedSource(url) {
  const candidates = cachedPath(url);
  const paths = Array.isArray(candidates) ? candidates : [candidates];
  for (const candidate of paths) {
    if (!candidate) continue;
    try {
      const stat = await fs.stat(candidate);
      if (stat.size > 1024) return true;
    } catch {
      // Check the next offline cache only.
    }
  }
  return false;
}

function sampleUrl(thumbnailUrl, index) {
  if (!thumbnailUrl?.endsWith("pl.jpg")) return null;
  return `${thumbnailUrl.slice(0, -"pl.jpg".length)}jp-${index}.jpg`;
}

function typeFromCurrent(row) {
  const value = String(row.current_type ?? "").toLowerCase();
  if (value.includes("center")) return "center";
  if (value.includes("right")) return "right";
  if (value.includes("full")) return "full";
  if (value.includes("sample")) return "sample";
  if (value.includes("scene")) return "scene_portrait";
  return value || "unknown";
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const [labels, snapshot, localOverrides, humanApprovals] = await Promise.all([
    loadThumbnailGoldLabels(root),
    fs.readFile(snapshotPath, "utf8").then(parseCsv),
    fs.readFile(localOverridesPath, "utf8").then(JSON.parse),
    fs.readFile(humanApprovalsPath, "utf8").then(parseCsv),
  ]);
  const humanApprovalsByCode = new Map(
    humanApprovals.map((approval) => [approval.code, approval]),
  );
  const byCode = new Map(snapshot.map((row) => [row.product_code, row]));
  const selectedLabels = new Map(
    [...labels].filter(([code]) => requestedCodes.size === 0 || requestedCodes.has(code)),
  );
  if (requestedCodes.size && selectedLabels.size !== requestedCodes.size) {
    const missing = [...requestedCodes].filter((code) => !selectedLabels.has(code));
    throw new Error(`GOLD_LABEL_UNKNOWN_CODE:${missing.join(",")}`);
  }
  const results = new Map();
  const reportRows = [];

  for (const label of selectedLabels.values()) {
    const row = byCode.get(label.productCode);
    if (!row) {
      results.set(label.productCode, { blocked: true, canonicalType: "missing", source: "" });
      reportRows.push({ product_code: label.productCode, current_type: "missing_snapshot", expected_type: label.type, expected_source: label.source, planned_type: "", planned_source: "", planned_url: "", status: "BLOCKER", reason: "missing_snapshot" });
      continue;
    }

    const samples = [];
    for (let index = 1; index <= Number(row.sample_count ?? 0); index += 1) {
      samples.push(sampleUrl(row.thumbnail_url, index));
    }
    const rightUrl = `/card-thumbnails/${row.product_code}-auto-right.jpg`;
    const centerUrl = `/card-thumbnails/${row.product_code}-auto-center.jpg`;
    const decision = resolveGoldThumbnail({
      label,
      currentUrl: row.current_card_thumbnail_url,
      fullUrl: row.thumbnail_url,
      rightUrl,
      centerUrl,
      samples,
    });

    let sourceAvailable = false;
    if (!decision?.blocked) {
      if (label.type === "right" || label.type === "center" || label.type === "full") sourceAvailable = await hasCachedSource(row.thumbnail_url);
      else sourceAvailable = await hasCachedSource(decision.url);
    }
    const blocked = Boolean(decision?.blocked) || !sourceAvailable;
    const result = blocked
      ? { blocked: true, canonicalType: decision?.canonicalType ?? "", source: decision?.source ?? "", code: decision?.code ?? "GOLD_SOURCE_NOT_CACHED" }
      : decision;
    results.set(label.productCode, result);
    reportRows.push({
      product_code: label.productCode,
      current_type: typeFromCurrent(row),
      expected_type: label.type,
      expected_source: label.source,
      planned_type: result.canonicalType ?? "",
      planned_source: result.source ?? "",
      planned_url: result.url ?? "",
      status: blocked ? "BLOCKER" : "PASS",
      reason: blocked ? (result.code ?? "GOLD_SOURCE_NOT_CACHED") : "exact_type_and_source",
    });
  }

  for (const [productCode, override] of Object.entries(localOverrides)) {
    const label = labels.get(productCode);
    const approval = humanApprovalsByCode.get(productCode);
    if (!label && !approval) {
      throw new Error(`LOCAL_OVERRIDE_WITHOUT_ACCEPTANCE_CONTRACT:${productCode}`);
    }
    if (label && (label.type !== override.mode || label.source !== override.sourceId)) {
      throw new Error(`LOCAL_OVERRIDE_GOLD_MISMATCH:${productCode}`);
    }
    if (!label && (
      approval.accepted_mode !== override.mode
      || approval.accepted_source_id !== override.sourceId
      || approval.accepted_image_hash !== override.sha256
    )) {
      throw new Error(`LOCAL_OVERRIDE_HUMAN_APPROVAL_MISMATCH:${productCode}`);
    }
    const overridePath = String(override.path);
    let buffer;
    if (overridePath.startsWith("/card-thumbnails/") && !overridePath.includes("..")) {
      buffer = await fs.readFile(path.join(root, "public", overridePath.replace(/^\//, "")));
    } else if (/^https:\/\/pics\.dmm\.co\.jp\//.test(overridePath)) {
      // Sample overrides may intentionally retain the exact approved DMM
      // source. Validate it against a saved offline cache, never the network.
      const candidates = cachedPath(overridePath);
      let cached = null;
      for (const candidate of Array.isArray(candidates) ? candidates : [candidates]) {
        try { cached = await fs.readFile(candidate); break; } catch { /* next saved cache */ }
      }
      if (!cached) throw new Error(`LOCAL_OVERRIDE_SOURCE_NOT_CACHED:${productCode}`);
      buffer = cached;
    } else {
      throw new Error(`LOCAL_OVERRIDE_INVALID_PATH:${productCode}`);
    }
    const digest = crypto.createHash("sha256").update(buffer).digest("hex");
    if (buffer.length === 0 || digest !== override.sha256) {
      throw new Error(`LOCAL_OVERRIDE_FILE_MISMATCH:${productCode}`);
    }
  }

  let acceptanceError = null;
  try {
    assertGoldAcceptance(results, selectedLabels);
  } catch (error) {
    acceptanceError = error;
  }
  const headers = ["product_code", "current_type", "expected_type", "expected_source", "planned_type", "planned_source", "planned_url", "status", "reason"];
  await fs.writeFile(path.join(outDir, "gold-label-acceptance.csv"), `${headers.join(",")}\n${reportRows.map((row) => headers.map((key) => csvCell(row[key])).join(",")).join("\n")}\n`);
  const passed = reportRows.filter((row) => row.status === "PASS").length;
  const blocked = reportRows.length - passed;
  const summary = [
    "# Gold label acceptance gate",
    "",
    `- Labels: ${reportRows.length}`,
    `- Pass: ${passed}`,
    `- Blocker: ${blocked}`,
    `- Result: ${blocked === 0 ? "PASS" : "STOP"}`,
    `- Local overrides: ${Object.keys(localOverrides).length}`,
    "",
    "`current_type` is the saved audit snapshot for comparison only. `planned_type` and `planned_source` are the actual selector contract tested by this gate.",
    "",
    "This is an offline gate. It resolves the exact reviewed type and source identifier before any image generation, DB update, import promotion, or deployment. A missing source, source mismatch, or type mismatch exits non-zero.",
  ];
  await fs.writeFile(path.join(outDir, "gold-label-acceptance.md"), `${summary.join("\n")}\n`);
  console.log(JSON.stringify({ labels: reportRows.length, passed, blocked, output: outDir }));
  if (acceptanceError || blocked) process.exitCode = 1;
}

await main();
