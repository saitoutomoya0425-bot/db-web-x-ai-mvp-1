import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalizeProductCodeValue } from "../src/lib/fanza/normalize.ts";
import { PRODUCTION_BASELINE_THUMBNAIL_DECISIONS } from "../src/lib/thumbnail/production-registry.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowlistPath = path.join(root, "data", "thumbnail-phase4b-legacy-allowlist.csv");
const exclusionsPath = path.join(root, "data", "thumbnail-phase4b-human-review-exclusions.csv");
const generatedPath = path.join(root, "src", "lib", "thumbnail", "generated-phase4b-legacy-registry.ts");

const EXPECTED_AUDIT_SHA256 = "89a4375b35c1e43e58a1b16aa7a273755fbd872dc90e88651193db419b9c73bd";
const EXPECTED_HUMAN_REVIEW_SHA256 = "5c4bcb19be41912f927e492a85e08389138943b782b59f98bfdbe07350772c9f";
const EXPECTED_CANONICAL_COUNT = 79;
const EXPECTED_CANONICAL_SHA256 = "2f906c24c1deefb7c955b73cfaeadde85ef95092c303aef58a5fe2cafdd34401";
const EXPECTED_COUNTS = Object.freeze({
  SAMPLE: 129,
  PACKAGE_RIGHT: 410,
  PACKAGE_CENTER: 141,
  PACKAGE_FULL: 116,
});
const EXPECTED_AUTO_COUNT = 796;
const EXPECTED_HUMAN_REVIEW_COUNT = 125;
const EXPECTED_REVIEW_COUNTS = Object.freeze({
  NON_RENDERABLE: 110,
  SAMPLE_CLOSE_MARGIN: 15,
});
const MODE_CONTRACTS = Object.freeze({
  SAMPLE: { source: /^sample:[1-9]\d*$/, object_fit: "cover" },
  PACKAGE_RIGHT: { source: /^dvd:right$/, object_fit: "cover" },
  PACKAGE_CENTER: { source: /^dvd:center$/, object_fit: "cover" },
  PACKAGE_FULL: { source: /^dvd:full$/, object_fit: "contain" },
});
const ALLOWLIST_HEADERS = Object.freeze([
  "audit_index",
  "code",
  "mode",
  "source_id",
  "audit_recommended_url",
  "resolved_url",
  "render_strategy",
  "object_fit",
  "object_position",
  "crop_spec",
  "approval_status",
]);
const EXCLUSION_HEADERS = Object.freeze([
  "audit_index",
  "code",
  "review_category",
  "recommended_mode",
]);

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const compareAscii = (left, right) => left < right ? -1 : left > right ? 1 : 0;

export function parseCsv(text) {
  const records = [];
  let field = "";
  let row = [];
  let quoted = false;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => {
    if (row.length || field) {
      pushField();
      records.push(row);
    }
    row = [];
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      pushField();
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      pushRow();
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("CSV_UNTERMINATED_QUOTED_FIELD");
  pushRow();
  const [rawHeader = [], ...rows] = records;
  const header = rawHeader.map((name) => name.replace(/^\uFEFF/, ""));
  return rows
    .filter((values) => values.some((value) => value.trim()))
    .map((values) => Object.fromEntries(header.map((name, index) => [name, values[index] ?? ""])));
}

function csvValue(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function serializeCsv(headers, rows) {
  return `${headers.join(",")}\n${rows.map((row) => headers.map((header) => csvValue(row[header])).join(",")).join("\n")}\n`;
}

function canonicalCode(value, context) {
  const normalized = canonicalizeProductCodeValue(value);
  if (!normalized.canonical || normalized.rejected || normalized.canonical !== value) {
    throw new Error(`${context}:INVALID_CANONICAL_CODE:${String(value)}`);
  }
  return normalized.canonical;
}

function trustedUrl(value, context) {
  const normalized = String(value ?? "").trim();
  if (/^\/card-thumbnails\/[A-Za-z0-9._-]+\.jpe?g$/i.test(normalized)) return normalized;
  try {
    const url = new URL(normalized);
    if (
      url.protocol === "https:" &&
      url.hostname === "pics.dmm.co.jp" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash
    ) return normalized;
  } catch {}
  throw new Error(`${context}:UNTRUSTED_URL:${normalized}`);
}

function canonicalRegistryDigest() {
  const entries = [...PRODUCTION_BASELINE_THUMBNAIL_DECISIONS.entries()].sort(([left], [right]) => compareAscii(left, right));
  return { count: entries.length, digest: sha256(JSON.stringify(entries)), codes: new Set(entries.map(([code]) => code)) };
}

function assertCanonicalRegistryUnchanged() {
  const canonical = canonicalRegistryDigest();
  if (canonical.count !== EXPECTED_CANONICAL_COUNT || canonical.digest !== EXPECTED_CANONICAL_SHA256) {
    throw new Error(`CANONICAL_REGISTRY_CHANGED:${canonical.count}:${canonical.digest}`);
  }
  return canonical.codes;
}

function trackedFiles() {
  const output = execFileSync("git", ["ls-files", "-z"], { cwd: root });
  return new Set(output.toString("utf8").split("\u0000").filter(Boolean));
}

async function isTrackedLocalOutput(url, tracked) {
  if (!url.startsWith("/card-thumbnails/")) return false;
  const repoPath = `public${url}`;
  if (!tracked.has(repoPath)) return false;
  const info = await fs.lstat(path.join(root, repoPath));
  return info.isFile() && !info.isSymbolicLink();
}

async function importAudit(auditFile, humanReviewFile) {
  const [auditBytes, humanBytes] = await Promise.all([fs.readFile(auditFile), fs.readFile(humanReviewFile)]);
  if (sha256(auditBytes) !== EXPECTED_AUDIT_SHA256) throw new Error("PHASE4A_AUDIT_SHA256_MISMATCH");
  if (sha256(humanBytes) !== EXPECTED_HUMAN_REVIEW_SHA256) throw new Error("PHASE4A_HUMAN_REVIEW_SHA256_MISMATCH");
  const auditRows = parseCsv(auditBytes.toString("utf8"));
  const humanRows = parseCsv(humanBytes.toString("utf8"));
  const autoRows = auditRows.filter((row) => row.decision === "自動確定可能");
  const reviewRows = auditRows.filter((row) => row.decision === "人間確認必要");
  if (auditRows.length !== EXPECTED_AUTO_COUNT + EXPECTED_HUMAN_REVIEW_COUNT) throw new Error(`AUDIT_COUNT:${auditRows.length}`);
  if (autoRows.length !== EXPECTED_AUTO_COUNT) throw new Error(`AUTO_COUNT:${autoRows.length}`);
  if (reviewRows.length !== EXPECTED_HUMAN_REVIEW_COUNT || humanRows.length !== EXPECTED_HUMAN_REVIEW_COUNT) throw new Error("HUMAN_REVIEW_COUNT_MISMATCH");
  const humanCodes = humanRows.map((row) => row.product_code).sort(compareAscii);
  const reviewCodes = reviewRows.map((row) => row.product_code).sort(compareAscii);
  if (JSON.stringify(humanCodes) !== JSON.stringify(reviewCodes)) throw new Error("HUMAN_REVIEW_FILES_DISAGREE");

  const tracked = trackedFiles();
  const allowlist = [];
  for (const row of autoRows) {
    const code = canonicalCode(row.product_code, "AUDIT");
    const contract = MODE_CONTRACTS[row.recommended_mode];
    if (!contract) throw new Error(`${code}:UNSUPPORTED_MODE:${row.recommended_mode}`);
    if (!contract.source.test(row.recommended_source_id)) throw new Error(`${code}:INVALID_SOURCE_ID:${row.recommended_source_id}`);
    const auditRecommendedUrl = trustedUrl(row.recommended_url, `${code}:AUDIT_RECOMMENDED_URL`);
    const direct = !auditRecommendedUrl.startsWith("/") || await isTrackedLocalOutput(auditRecommendedUrl, tracked);
    let resolvedUrl = auditRecommendedUrl;
    let renderStrategy = "AUDIT_OUTPUT";
    if (!direct) {
      if (row.recommended_mode !== "PACKAGE_RIGHT" && row.recommended_mode !== "PACKAGE_CENTER") {
        throw new Error(`${code}:MISSING_AUDIT_OUTPUT_WITHOUT_CSS_STRATEGY`);
      }
      resolvedUrl = trustedUrl(row.candidate_full_url, `${code}:CSS_SOURCE_URL`);
      if (!resolvedUrl.startsWith("https://")) throw new Error(`${code}:CSS_SOURCE_MUST_BE_REMOTE_FULL`);
      renderStrategy = "CSS_PACKAGE_POSITION";
    }
    allowlist.push({
      audit_index: row.audit_index,
      code,
      mode: row.recommended_mode,
      source_id: row.recommended_source_id,
      audit_recommended_url: auditRecommendedUrl,
      resolved_url: resolvedUrl,
      render_strategy: renderStrategy,
      object_fit: contract.object_fit,
      object_position: row.recommended_mode === "PACKAGE_RIGHT" ? "right" : "center",
      crop_spec: "null",
      approval_status: "UNREVIEWED",
    });
  }
  allowlist.sort((left, right) => compareAscii(left.code, right.code));
  const exclusions = reviewRows.map((row) => ({
    audit_index: row.audit_index,
    code: canonicalCode(row.product_code, "HUMAN_REVIEW"),
    review_category: row.recommended_mode === "NON_RENDERABLE" ? "NON_RENDERABLE" : "SAMPLE_CLOSE_MARGIN",
    recommended_mode: row.recommended_mode,
  })).sort((left, right) => compareAscii(left.code, right.code));
  await Promise.all([
    fs.writeFile(allowlistPath, serializeCsv(ALLOWLIST_HEADERS, allowlist)),
    fs.writeFile(exclusionsPath, serializeCsv(EXCLUSION_HEADERS, exclusions)),
  ]);
}

function countBy(rows, key) {
  return rows.reduce((counts, row) => {
    counts[row[key]] = (counts[row[key]] ?? 0) + 1;
    return counts;
  }, {});
}

function assertExactCounts(actual, expected, context) {
  const actualKeys = Object.keys(actual).sort(compareAscii);
  const expectedKeys = Object.keys(expected).sort(compareAscii);
  if (
    JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys) ||
    expectedKeys.some((key) => actual[key] !== expected[key])
  ) {
    throw new Error(`${context}:${JSON.stringify(actual)}`);
  }
}

async function loadAndValidateInputs() {
  const [allowlistText, exclusionsText] = await Promise.all([
    fs.readFile(allowlistPath, "utf8"),
    fs.readFile(exclusionsPath, "utf8"),
  ]);
  const allowlist = parseCsv(allowlistText);
  const exclusions = parseCsv(exclusionsText);
  if (allowlist.length !== EXPECTED_AUTO_COUNT) throw new Error(`ALLOWLIST_COUNT:${allowlist.length}`);
  if (exclusions.length !== EXPECTED_HUMAN_REVIEW_COUNT) throw new Error(`EXCLUSION_COUNT:${exclusions.length}`);
  assertExactCounts(countBy(allowlist, "mode"), EXPECTED_COUNTS, "ALLOWLIST_MODE_COUNTS");
  assertExactCounts(countBy(exclusions, "review_category"), EXPECTED_REVIEW_COUNTS, "EXCLUSION_COUNTS");
  const canonicalCodes = assertCanonicalRegistryUnchanged();
  const tracked = trackedFiles();
  const seen = new Set();
  const exclusionCodes = new Set(exclusions.map((row) => canonicalCode(row.code, "EXCLUSION")));
  for (const row of allowlist) {
    const code = canonicalCode(row.code, "ALLOWLIST");
    if (seen.has(code)) throw new Error(`${code}:DUPLICATE_ALLOWLIST_CODE`);
    seen.add(code);
    if (canonicalCodes.has(code)) throw new Error(`${code}:CANONICAL_OVERLAP`);
    if (exclusionCodes.has(code)) throw new Error(`${code}:HUMAN_REVIEW_OVERLAP`);
    const contract = MODE_CONTRACTS[row.mode];
    if (!contract || row.mode === "SCENE_CROP") throw new Error(`${code}:INVALID_MODE`);
    if (!contract.source.test(row.source_id)) throw new Error(`${code}:INVALID_SOURCE_ID`);
    if (row.object_fit !== contract.object_fit || row.crop_spec !== "null" || row.approval_status !== "UNREVIEWED") throw new Error(`${code}:INVALID_RENDER_OR_APPROVAL_CONTRACT`);
    if (row.object_position !== (row.mode === "PACKAGE_RIGHT" ? "right" : "center")) throw new Error(`${code}:INVALID_OBJECT_POSITION`);
    trustedUrl(row.audit_recommended_url, `${code}:AUDIT_RECOMMENDED_URL`);
    trustedUrl(row.resolved_url, `${code}:RESOLVED_URL`);
    if (row.render_strategy === "AUDIT_OUTPUT") {
      if (row.resolved_url !== row.audit_recommended_url) throw new Error(`${code}:DIRECT_URL_CHANGED`);
      if (row.resolved_url.startsWith("/")) {
        if (!await isTrackedLocalOutput(row.resolved_url, tracked)) {
          throw new Error(`${code}:LOCAL_OUTPUT_NOT_TRACKED`);
        }
      }
    } else if (row.render_strategy === "CSS_PACKAGE_POSITION") {
      if ((row.mode !== "PACKAGE_RIGHT" && row.mode !== "PACKAGE_CENTER") || !row.resolved_url.startsWith("https://")) throw new Error(`${code}:INVALID_CSS_STRATEGY`);
    } else {
      throw new Error(`${code}:INVALID_RENDER_STRATEGY`);
    }
  }
  return { allowlist, exclusions, allowlistText, exclusionsText };
}

function generatedSource({ allowlist, exclusions, allowlistText, exclusionsText }) {
  const records = allowlist.map((row) => ({
    code: row.code,
    mode: row.mode,
    source_id: row.source_id,
    resolved_url: row.resolved_url,
    render_strategy: row.render_strategy,
    object_fit: row.object_fit,
    object_position: row.object_position,
  }));
  const cssCount = records.filter((record) => record.render_strategy === "CSS_PACKAGE_POSITION").length;
  const source = `/* This file is generated by scripts/generate-thumbnail-phase4b-legacy-registry.mjs. */\n/* Do not edit it by hand. It is static and safe for client bundles. */\n\nexport const GENERATED_PHASE4B_LEGACY_RECORDS = Object.freeze(\n  ${JSON.stringify(records, null, 2)},\n);\n\nexport const GENERATED_PHASE4B_LEGACY_STATS = Object.freeze(${JSON.stringify({
    total: records.length,
    SAMPLE: EXPECTED_COUNTS.SAMPLE,
    PACKAGE_RIGHT: EXPECTED_COUNTS.PACKAGE_RIGHT,
    PACKAGE_CENTER: EXPECTED_COUNTS.PACKAGE_CENTER,
    PACKAGE_FULL: EXPECTED_COUNTS.PACKAGE_FULL,
    SCENE_CROP: 0,
    human_review_excluded: exclusions.length,
    css_package_position: cssCount,
    canonical_count_unchanged: EXPECTED_CANONICAL_COUNT,
    canonical_registry_sha256: EXPECTED_CANONICAL_SHA256,
    allowlist_sha256: sha256(allowlistText),
    exclusions_sha256: sha256(exclusionsText),
    phase4a_audit_sha256: EXPECTED_AUDIT_SHA256,
    phase4a_human_review_sha256: EXPECTED_HUMAN_REVIEW_SHA256,
  }, null, 2)});\n`;
  return source;
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const importIndex = args.indexOf("--import-audit");
  if (importIndex >= 0) {
    const auditFile = args[importIndex + 1];
    const humanReviewFile = args[importIndex + 2];
    if (!auditFile || !humanReviewFile) throw new Error("--import-audit requires audit and human-review CSV paths");
    await importAudit(path.resolve(auditFile), path.resolve(humanReviewFile));
  }
  const inputs = await loadAndValidateInputs();
  const source = generatedSource(inputs);
  if (check) {
    const current = await fs.readFile(generatedPath, "utf8");
    if (current !== source) throw new Error("GENERATED_PHASE4B_REGISTRY_OUT_OF_DATE");
    console.log("Phase 4B registry check passed: 796 records; canonical registry unchanged.");
    return;
  }
  await fs.writeFile(generatedPath, source);
  console.log("Generated Phase 4B registry: 796 records; 125 human-review exclusions preserved.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
