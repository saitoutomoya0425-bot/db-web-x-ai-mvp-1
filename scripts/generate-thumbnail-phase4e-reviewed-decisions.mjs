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
const inputPath = path.join(root, "data", "thumbnail-phase4e-reviewed-decisions.csv");
const generatedPath = path.join(
  root,
  "src",
  "lib",
  "thumbnail",
  "generated-phase4e-reviewed-decisions.ts",
);
const EXPECTED_COUNT = 4;
const EXPECTED_APPROVED_BY = "USER_HANDOFF";
const EXPECTED_APPROVED_AT = "2026-08-03";
const EXPECTED_APPROVAL_BATCH = "PHASE_4E_USER_REVIEW";
const SHA256 = /^[a-f0-9]{64}$/;
const MODE_COUNTS = Object.freeze({ SAMPLE: 4 });
const EXPECTED_HEADERS = Object.freeze([
  "code",
  "mode",
  "source_id",
  "source_kind",
  "source_path_or_url",
  "source_local_path",
  "source_width",
  "source_height",
  "source_hash",
  "output_path_or_url",
  "output_hash",
  "object_fit",
  "crop_spec",
  "approval_status",
  "render_status",
  "approved_by",
  "approved_at",
  "approval_batch",
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

function assertedDimension(value, context) {
  const dimension = Number(value);
  if (!Number.isSafeInteger(dimension) || dimension <= 0) {
    throw new Error(`${context}:INVALID_DIMENSION`);
  }
  return dimension;
}

function canonicalCode(value) {
  const raw = requiredText(value, "PHASE4E:CODE");
  const result = canonicalizeProductCodeValue(raw);
  if (!result.canonical || result.rejected || result.canonical !== raw) {
    throw new Error(`PHASE4E:INVALID_CANONICAL_CODE:${raw}`);
  }
  return raw;
}

function expectedSampleUrl(code, sourceId) {
  const match = /^sample:([1-9]\d*)$/.exec(sourceId);
  if (!match) throw new Error(`PHASE4E:${code}:INVALID_SAMPLE_SOURCE_ID`);
  const slug = code.toLowerCase();
  return `https://pics.dmm.co.jp/digital/video/${slug}/${slug}jp-${match[1]}.jpg`;
}

function assertSafeDmmUrl(value, context) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${context}:INVALID_URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "pics.dmm.co.jp" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${context}:UNSAFE_URL`);
  }
}

function jpegDimensions(bytes, context) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error(`${context}:INVALID_JPEG`);
  }
  const sof = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    let marker = bytes[offset + 1];
    offset += 2;
    while (marker === 0xff && offset < bytes.length) {
      marker = bytes[offset];
      offset += 1;
    }
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (sof.has(marker) && offset + 7 <= bytes.length) {
      return {
        height: bytes.readUInt16BE(offset + 3),
        width: bytes.readUInt16BE(offset + 5),
      };
    }
    if (length < 2) break;
    offset += length;
  }
  throw new Error(`${context}:JPEG_DIMENSIONS_NOT_FOUND`);
}

async function verifyLocalSource(code, sourceLocalPath, expectedHash, expectedWidth, expectedHeight) {
  const absolute = path.resolve(root, sourceLocalPath);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`PHASE4E:${code}:LOCAL_SOURCE_OUTSIDE_REPOSITORY`);
  }
  const expectedPath = `tmp/card-rebuild/downloads/${code}-sample-1.jpg`;
  if (sourceLocalPath !== expectedPath) {
    throw new Error(`PHASE4E:${code}:LOCAL_SOURCE_PATH_MISMATCH`);
  }
  const info = await fs.lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`PHASE4E:${code}:LOCAL_SOURCE_NOT_REGULAR_FILE`);
  }
  const bytes = await fs.readFile(absolute);
  if (!bytes.length) throw new Error(`PHASE4E:${code}:LOCAL_SOURCE_EMPTY`);
  if (sha256(bytes) !== expectedHash) {
    throw new Error(`PHASE4E:${code}:LOCAL_SOURCE_HASH_MISMATCH`);
  }
  const dimensions = jpegDimensions(bytes, `PHASE4E:${code}`);
  if (dimensions.width !== expectedWidth || dimensions.height !== expectedHeight) {
    throw new Error(`PHASE4E:${code}:LOCAL_SOURCE_DIMENSION_MISMATCH`);
  }
}

async function materializeRecord(row) {
  const code = canonicalCode(row.code);
  const context = `PHASE4E:${code}`;
  const sourceId = requiredText(row.source_id, `${context}:SOURCE_ID`);
  const sourcePath = requiredText(row.source_path_or_url, `${context}:SOURCE_PATH`);
  const sourceLocalPath = requiredText(row.source_local_path, `${context}:SOURCE_LOCAL_PATH`);
  const sourceHash = assertedHash(row.source_hash, `${context}:SOURCE_HASH`);
  const outputPath = requiredText(row.output_path_or_url, `${context}:OUTPUT_PATH`);
  const outputHash = assertedHash(row.output_hash, `${context}:OUTPUT_HASH`);
  const sourceWidth = assertedDimension(row.source_width, `${context}:SOURCE_WIDTH`);
  const sourceHeight = assertedDimension(row.source_height, `${context}:SOURCE_HEIGHT`);
  const approvedBy = requiredText(row.approved_by, `${context}:APPROVED_BY`);
  const approvedAt = requiredText(row.approved_at, `${context}:APPROVED_AT`);
  const approvalBatch = requiredText(row.approval_batch, `${context}:APPROVAL_BATCH`);
  const reason = requiredText(row.reason, `${context}:REASON`);

  if (row.apply !== "true") throw new Error(`${context}:NOT_APPLIED`);
  if (
    row.mode !== "SAMPLE" ||
    sourceId !== "sample:1" ||
    row.source_kind !== "SAMPLE" ||
    row.object_fit !== "scale-down" ||
    row.crop_spec !== "null" ||
    row.approval_status !== "HUMAN_APPROVED" ||
    row.render_status !== "READY"
  ) {
    throw new Error(`${context}:DECISION_CONTRACT_MISMATCH`);
  }
  if (
    approvedBy !== EXPECTED_APPROVED_BY ||
    approvedAt !== EXPECTED_APPROVED_AT ||
    approvalBatch !== EXPECTED_APPROVAL_BATCH
  ) {
    throw new Error(`${context}:APPROVAL_PROVENANCE_MISMATCH`);
  }
  if (sourceHash !== outputHash || sourcePath !== outputPath) {
    throw new Error(`${context}:TRANSFORMED_OUTPUT_NOT_ALLOWED`);
  }
  const expectedUrl = expectedSampleUrl(code, sourceId);
  assertSafeDmmUrl(sourcePath, context);
  if (sourcePath !== expectedUrl) {
    throw new Error(`${context}:SAMPLE_URL_CONTRACT_MISMATCH`);
  }
  await verifyLocalSource(code, sourceLocalPath, sourceHash, sourceWidth, sourceHeight);

  const record = {
    code,
    mode: "SAMPLE",
    state: "RESOLVED",
    source_id: sourceId,
    source_path_or_url: sourcePath,
    source_hash: sourceHash,
    output_path_or_url: outputPath,
    output_hash: outputHash,
    crop_spec: null,
    approved_by: approvedBy,
    approved_at: approvedAt,
    approval_batch: approvalBatch,
    reason,
  };
  adaptHumanApprovalRecord(record);
  return record;
}

function stableSource({ records, inputHash }) {
  return `/* This file is generated by scripts/generate-thumbnail-phase4e-reviewed-decisions.mjs. */
/* Do not edit it by hand. It is static and safe for client bundles. */

import type { CanonicalDecisionRecord } from "./adapters.ts";

export const GENERATED_PHASE4E_REVIEWED_DECISION_RECORDS = Object.freeze(
  ${JSON.stringify(records, null, 2)} as const satisfies readonly CanonicalDecisionRecord[],
);

export const GENERATED_PHASE4E_REVIEWED_STATS = Object.freeze(
  ${JSON.stringify({ total: EXPECTED_COUNT, ...MODE_COUNTS, auto_applied: 0 }, null, 2)} as const,
);

export const GENERATED_PHASE4E_REVIEWED_INPUT_SHA256 = ${JSON.stringify(inputHash)};
`;
}

export async function generatePhase4ESource({ decisionFilePath = inputPath } = {}) {
  const input = await fs.readFile(decisionFilePath, "utf8");
  const header = input.slice(0, input.indexOf("\n")).replace(/\r$/, "").split(",");
  if (JSON.stringify(header) !== JSON.stringify(EXPECTED_HEADERS)) {
    throw new Error("PHASE4E:INVALID_HEADERS");
  }
  const rows = parseCsv(input);
  if (rows.length !== EXPECTED_COUNT) {
    throw new Error(`PHASE4E:COUNT_MISMATCH:${rows.length}:${EXPECTED_COUNT}`);
  }
  const records = [];
  const seen = new Set();
  for (const row of rows) {
    const record = await materializeRecord(row);
    if (seen.has(record.code)) throw new Error(`PHASE4E:DUPLICATE_CODE:${record.code}`);
    seen.add(record.code);
    records.push(record);
  }
  records.sort((left, right) => compareAscii(left.code, right.code));
  const inputHash = sha256(input);
  return { records, inputHash, source: stableSource({ records, inputHash }) };
}

export async function runCli(args = process.argv.slice(2)) {
  const result = await generatePhase4ESource();
  if (args.includes("--write")) {
    await writeFileAtomically(generatedPath, result.source);
  } else if (args.includes("--check")) {
    const existing = await fs.readFile(generatedPath, "utf8");
    if (existing !== result.source) {
      throw new Error("PHASE4E_REVIEWED_REGISTRY_OUT_OF_SYNC");
    }
  } else {
    process.stdout.write(result.source);
  }
  console.error(JSON.stringify({ total: EXPECTED_COUNT, ...MODE_COUNTS, auto_applied: 0 }));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await runCli();
