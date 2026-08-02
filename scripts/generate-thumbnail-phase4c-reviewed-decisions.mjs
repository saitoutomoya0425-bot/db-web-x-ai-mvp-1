import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalizeProductCodeValue } from "../src/lib/fanza/normalize.ts";
import { adaptHumanApprovalRecord } from "../src/lib/thumbnail/adapters.ts";
import {
  parseCsv,
  writeFileAtomically,
} from "./generate-thumbnail-production-registry.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inputPath = path.join(root, "data", "thumbnail-phase4c-reviewed-decisions.csv");
const generatedPath = path.join(
  root,
  "src",
  "lib",
  "thumbnail",
  "generated-phase4c-reviewed-decisions.ts",
);
const EXPECTED_COUNT = 15;
const EXPECTED_APPROVED_BY = "USER_HANDOFF";
const EXPECTED_APPROVED_AT = "2026-08-02";
const SHA256 = /^[a-f0-9]{64}$/;
const MODE_COUNTS = Object.freeze({ SAMPLE: 9, PACKAGE_RIGHT: 6 });
const EXPECTED_HEADERS = Object.freeze([
  "code",
  "mode",
  "source_id",
  "source_path_or_url",
  "source_hash",
  "output_path_or_url",
  "output_hash",
  "approved_by",
  "approved_at",
  "reason",
  "apply",
]);

const compareAscii = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function requiredText(value, context) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${context}:MISSING_VALUE`);
  return text;
}

function assertedHash(value, context) {
  const hash = requiredText(value, context).toLowerCase();
  if (!SHA256.test(hash)) throw new Error(`${context}:INVALID_SHA256`);
  return hash;
}

function canonicalCode(value) {
  const raw = requiredText(value, "PHASE4C:CODE");
  const result = canonicalizeProductCodeValue(raw);
  if (!result.canonical || result.rejected || result.canonical !== raw) {
    throw new Error(`PHASE4C:INVALID_CANONICAL_CODE:${raw}`);
  }
  return raw;
}

function expectedSampleUrl(code, sourceId) {
  const match = /^sample:([1-9]\d*)$/.exec(sourceId);
  if (!match) throw new Error(`PHASE4C:${code}:INVALID_SAMPLE_SOURCE_ID`);
  const slug = code.toLowerCase();
  return `https://pics.dmm.co.jp/digital/video/${slug}/${slug}jp-${match[1]}.jpg`;
}

async function verifyLocalRightSource(code, sourcePath, outputPath, expectedHash) {
  const expectedSource = `public/card-thumbnails/${code}-auto-right.jpg`;
  const expectedOutput = `/card-thumbnails/${code}-auto-right.jpg`;
  if (sourcePath !== expectedSource || outputPath !== expectedOutput) {
    throw new Error(`PHASE4C:${code}:RIGHT_PATH_CONTRACT_MISMATCH`);
  }
  const absolute = path.join(root, sourcePath);
  const info = await fs.lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`PHASE4C:${code}:RIGHT_SOURCE_NOT_REGULAR_FILE`);
  }
  const bytes = await fs.readFile(absolute);
  if (!bytes.length) throw new Error(`PHASE4C:${code}:RIGHT_SOURCE_EMPTY`);
  if (sha256(bytes) !== expectedHash) {
    throw new Error(`PHASE4C:${code}:RIGHT_SOURCE_HASH_MISMATCH`);
  }
}

async function materializeRecord(row) {
  const code = canonicalCode(row.code);
  const context = `PHASE4C:${code}`;
  const mode = requiredText(row.mode, `${context}:MODE`);
  const sourceId = requiredText(row.source_id, `${context}:SOURCE_ID`);
  const sourcePath = requiredText(row.source_path_or_url, `${context}:SOURCE_PATH`);
  const outputPath = requiredText(row.output_path_or_url, `${context}:OUTPUT_PATH`);
  const sourceHash = assertedHash(row.source_hash, `${context}:SOURCE_HASH`);
  const outputHash = assertedHash(row.output_hash, `${context}:OUTPUT_HASH`);
  const approvedBy = requiredText(row.approved_by, `${context}:APPROVED_BY`);
  const approvedAt = requiredText(row.approved_at, `${context}:APPROVED_AT`);
  const reason = requiredText(row.reason, `${context}:REASON`);

  if (row.apply !== "true") throw new Error(`${context}:NOT_APPLIED`);
  if (approvedBy !== EXPECTED_APPROVED_BY || approvedAt !== EXPECTED_APPROVED_AT) {
    throw new Error(`${context}:APPROVAL_PROVENANCE_MISMATCH`);
  }
  if (sourceHash !== outputHash) {
    throw new Error(`${context}:TRANSFORMED_OUTPUT_NOT_ALLOWED`);
  }
  if (mode === "PACKAGE_RIGHT") {
    if (sourceId !== "dvd:right") throw new Error(`${context}:INVALID_RIGHT_SOURCE_ID`);
    await verifyLocalRightSource(code, sourcePath, outputPath, sourceHash);
  } else if (mode === "SAMPLE") {
    const expectedUrl = expectedSampleUrl(code, sourceId);
    if (sourcePath !== expectedUrl || outputPath !== expectedUrl) {
      throw new Error(`${context}:SAMPLE_URL_CONTRACT_MISMATCH`);
    }
  } else {
    throw new Error(`${context}:UNSUPPORTED_MODE`);
  }

  const record = {
    code,
    mode,
    state: "RESOLVED",
    source_id: sourceId,
    source_path_or_url: sourcePath,
    source_hash: sourceHash,
    output_path_or_url: outputPath,
    output_hash: outputHash,
    crop_spec: null,
    approved_by: approvedBy,
    approved_at: approvedAt,
    reason,
  };
  adaptHumanApprovalRecord(record);
  return record;
}

function stableSource({ records, inputHash }) {
  return `/* This file is generated by scripts/generate-thumbnail-phase4c-reviewed-decisions.mjs. */
/* Do not edit it by hand. It is static and safe for client bundles. */

import type { CanonicalDecisionRecord } from "./adapters.ts";

export const GENERATED_PHASE4C_REVIEWED_DECISION_RECORDS = Object.freeze(
  ${JSON.stringify(records, null, 2)} as const satisfies readonly CanonicalDecisionRecord[],
);

export const GENERATED_PHASE4C_REVIEWED_STATS = Object.freeze(
  ${JSON.stringify({ total: EXPECTED_COUNT, ...MODE_COUNTS }, null, 2)} as const,
);

export const GENERATED_PHASE4C_REVIEWED_INPUT_SHA256 = ${JSON.stringify(inputHash)};
`;
}

export async function generatePhase4CSource({
  decisionFilePath = inputPath,
} = {}) {
  const input = await fs.readFile(decisionFilePath, "utf8");
  const header = input.slice(0, input.indexOf("\n")).replace(/\r$/, "").split(",");
  if (JSON.stringify(header) !== JSON.stringify(EXPECTED_HEADERS)) {
    throw new Error("PHASE4C:INVALID_HEADERS");
  }
  const rows = parseCsv(input);
  if (rows.length !== EXPECTED_COUNT) {
    throw new Error(`PHASE4C:COUNT_MISMATCH:${rows.length}:${EXPECTED_COUNT}`);
  }
  const records = [];
  const seen = new Set();
  for (const row of rows) {
    const record = await materializeRecord(row);
    if (seen.has(record.code)) throw new Error(`PHASE4C:DUPLICATE_CODE:${record.code}`);
    seen.add(record.code);
    records.push(record);
  }
  records.sort((left, right) => compareAscii(left.code, right.code));
  const counts = records.reduce((result, record) => {
    result[record.mode] = (result[record.mode] ?? 0) + 1;
    return result;
  }, {});
  if (
    Object.keys(counts).length !== Object.keys(MODE_COUNTS).length ||
    Object.entries(MODE_COUNTS).some(([mode, count]) => counts[mode] !== count)
  ) {
    throw new Error(`PHASE4C:MODE_COUNT_MISMATCH:${JSON.stringify(counts)}`);
  }
  const inputHash = sha256(input);
  return { records, inputHash, source: stableSource({ records, inputHash }) };
}

export async function runCli(args = process.argv.slice(2)) {
  const result = await generatePhase4CSource();
  if (args.includes("--write")) {
    await writeFileAtomically(generatedPath, result.source);
  } else if (args.includes("--check")) {
    const existing = await fs.readFile(generatedPath, "utf8");
    if (existing !== result.source) {
      throw new Error("PHASE4C_REVIEWED_REGISTRY_OUT_OF_SYNC");
    }
  } else {
    process.stdout.write(result.source);
  }
  console.error(JSON.stringify({ total: EXPECTED_COUNT, ...MODE_COUNTS }));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await runCli();
