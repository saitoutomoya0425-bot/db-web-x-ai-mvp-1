import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { isTrustedThumbnailOutput } from "../src/lib/thumbnail/contract.ts";
import { parseCsv } from "./generate-thumbnail-production-registry.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultDecisionInput = path.join(root, "data", "thumbnail-phase5-reviewed-decisions.csv");
const defaultEvidenceInput = path.join(
  process.env.HOME ?? "",
  "Documents",
  "Codex",
  "okazudb-state",
  "thumbnail-reviews",
  "phase5f-canary-30",
  "canary-30.csv",
);
const SHA256 = /^[a-f0-9]{64}$/;
const CROP_RATIO = 0.735;

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const text = (value, context) => {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${context}:MISSING_VALUE`);
  return normalized;
};
const integer = (value, context, { allowZero = false } = {}) => {
  const normalized = text(value, context);
  const parsed = Number(normalized);
  if (
    !Number.isSafeInteger(parsed)
    || parsed < (allowZero ? 0 : 1)
    || String(parsed) !== normalized
  ) {
    throw new Error(`${context}:INVALID_INTEGER`);
  }
  return parsed;
};

function safeOutputPath(repositoryRoot, code, mode, outputPath) {
  const expectedSuffix = mode === "PACKAGE_RIGHT" ? "auto-right.jpg" : "auto-center.jpg";
  const expected = `/card-thumbnails/${code}-${expectedSuffix}`;
  if (outputPath !== expected || !isTrustedThumbnailOutput(outputPath)) {
    throw new Error(`PHASE5_MATERIALIZER:${code}:OUTPUT_PATH_CONTRACT`);
  }
  const publicRoot = path.resolve(repositoryRoot, "public", "card-thumbnails");
  const absolute = path.resolve(repositoryRoot, `public${outputPath}`);
  if (!absolute.startsWith(`${publicRoot}${path.sep}`)) {
    throw new Error(`PHASE5_MATERIALIZER:${code}:OUTPUT_PATH_ESCAPE`);
  }
  return absolute;
}

async function officialBytes(url, expectedHash, fetchImpl, downloadCache, context) {
  if (!isTrustedThumbnailOutput(url) || !url.startsWith("https://pics.dmm.co.jp/")) {
    throw new Error(`${context}:UNTRUSTED_SOURCE_URL`);
  }
  let bytes = downloadCache.get(url);
  if (!bytes) {
    const response = await fetchImpl(url, { redirect: "error" });
    if (!response.ok) throw new Error(`${context}:SOURCE_HTTP_${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new Error(`${context}:EMPTY_SOURCE`);
    downloadCache.set(url, bytes);
  }
  if (sha256(bytes) !== expectedHash) throw new Error(`${context}:SOURCE_HASH_MISMATCH`);
  return bytes;
}

async function existingOutputState(absolute, expectedHash, context) {
  try {
    const info = await fs.lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${context}:OUTPUT_NOT_REGULAR_FILE`);
    const bytes = await fs.readFile(absolute);
    if (sha256(bytes) !== expectedHash) throw new Error(`${context}:EXISTING_OUTPUT_DIFFERS`);
    return "reused";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

async function writeNewOutput(absolute, bytes, context) {
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  let handle;
  try {
    handle = await fs.open(absolute, "wx", 0o644);
    await handle.writeFile(bytes);
  } catch (error) {
    if (error?.code === "EEXIST") {
      const state = await existingOutputState(absolute, sha256(bytes), context);
      if (state === "reused") return "reused";
    }
    throw error;
  } finally {
    await handle?.close();
  }
  return "created";
}

export async function materializePhase5ReviewedAssets({
  decisionFilePath = defaultDecisionInput,
  evidenceFilePath = defaultEvidenceInput,
  repositoryRoot = root,
  fetchImpl = fetch,
  write = false,
} = {}) {
  const decisions = parseCsv(await fs.readFile(decisionFilePath, "utf8"))
    .filter((row) => row.apply === "true");
  const evidenceRows = parseCsv(await fs.readFile(evidenceFilePath, "utf8"));
  const evidenceByCode = new Map();
  for (const evidence of evidenceRows) {
    const code = text(evidence.product_code, "PHASE5_MATERIALIZER:EVIDENCE_CODE");
    if (evidenceByCode.has(code)) throw new Error(`PHASE5_MATERIALIZER:${code}:DUPLICATE_EVIDENCE`);
    evidenceByCode.set(code, evidence);
  }
  if (evidenceByCode.size !== decisions.length) {
    throw new Error("PHASE5_MATERIALIZER:EVIDENCE_TARGET_COUNT_MISMATCH");
  }
  const downloadCache = new Map();
  const results = [];
  for (const decision of decisions) {
    const code = text(decision.code, "PHASE5_MATERIALIZER:CODE");
    const context = `PHASE5_MATERIALIZER:${code}`;
    const evidence = evidenceByCode.get(code);
    if (!evidence) throw new Error(`${context}:EVIDENCE_MISSING`);
    const matchedFields = [
      ["mode", "mode"],
      ["source_id", "source_id"],
      ["source_path_or_url", "source_path_or_url"],
      ["source_hash", "source_hash"],
      ["output_path_or_url", "output_path_or_url"],
      ["output_hash", "output_hash"],
    ];
    for (const [decisionField, evidenceField] of matchedFields) {
      if (decision[decisionField] !== evidence[evidenceField]) {
        throw new Error(`${context}:EVIDENCE_${decisionField.toUpperCase()}_MISMATCH`);
      }
    }
    if (evidence.apply !== "true") throw new Error(`${context}:EVIDENCE_NOT_APPROVED_FOR_APPLY`);
    const row = { ...evidence, ...decision };
    const mode = text(row.mode, `${context}:MODE`);
    const sourceId = text(row.source_id, `${context}:SOURCE_ID`);
    const sourcePath = text(row.source_path_or_url, `${context}:SOURCE_PATH`);
    const sourceHash = text(row.source_hash, `${context}:SOURCE_HASH`).toLowerCase();
    const outputPath = text(row.output_path_or_url, `${context}:OUTPUT_PATH`);
    const outputHash = text(row.output_hash, `${context}:OUTPUT_HASH`).toLowerCase();
    if (!SHA256.test(sourceHash) || !SHA256.test(outputHash)) {
      throw new Error(`${context}:HASH_CONTRACT`);
    }
    if (mode === "PACKAGE_FULL") {
      if (
        sourceId !== "dvd:full"
        || sourcePath !== outputPath
        || sourceHash !== outputHash
        || row.crop_left !== ""
        || row.crop_width !== ""
      ) {
        throw new Error(`${context}:FULL_PROVENANCE_CONTRACT`);
      }
      const bytes = await officialBytes(sourcePath, sourceHash, fetchImpl, downloadCache, context);
      const metadata = await sharp(bytes).metadata();
      const sourceWidth = integer(row.source_width, `${context}:SOURCE_WIDTH`);
      const sourceHeight = integer(row.source_height, `${context}:SOURCE_HEIGHT`);
      if (metadata.width !== sourceWidth || metadata.height !== sourceHeight) {
        throw new Error(`${context}:SOURCE_DIMENSIONS_MISMATCH`);
      }
      results.push(Object.freeze({ code, mode, source_id: sourceId, output_path: outputPath, state: "verified_remote" }));
      continue;
    }
    if (mode !== "PACKAGE_RIGHT" && mode !== "PACKAGE_CENTER") {
      throw new Error(`${context}:UNSUPPORTED_CANARY_MODE`);
    }
    const expectedSourceId = mode === "PACKAGE_RIGHT" ? "dvd:right" : "dvd:center";
    if (sourceId !== expectedSourceId) throw new Error(`${context}:SOURCE_ID_CONTRACT`);
    const absolute = safeOutputPath(repositoryRoot, code, mode, outputPath);
    const existing = await existingOutputState(absolute, outputHash, context);
    if (!write && existing === "missing") throw new Error(`${context}:OUTPUT_MISSING`);
    const source = await officialBytes(sourcePath, sourceHash, fetchImpl, downloadCache, context);
    const sourceWidth = integer(row.source_width, `${context}:SOURCE_WIDTH`);
    const sourceHeight = integer(row.source_height, `${context}:SOURCE_HEIGHT`);
    const cropLeft = integer(row.crop_left, `${context}:CROP_LEFT`, { allowZero: true });
    const cropWidth = integer(row.crop_width, `${context}:CROP_WIDTH`);
    const expectedWidth = Math.max(1, Math.min(sourceWidth, Math.round(sourceHeight * CROP_RATIO)));
    const expectedLeft = mode === "PACKAGE_CENTER"
      ? Math.max(0, Math.round((sourceWidth - expectedWidth) / 2))
      : Math.max(0, sourceWidth - expectedWidth);
    const metadata = await sharp(source).metadata();
    if (metadata.width !== sourceWidth || metadata.height !== sourceHeight) {
      throw new Error(`${context}:SOURCE_DIMENSIONS_MISMATCH`);
    }
    if (cropWidth !== expectedWidth || cropLeft !== expectedLeft) {
      throw new Error(`${context}:CROP_PROVENANCE_MISMATCH`);
    }
    const output = await sharp(source)
      .extract({ left: cropLeft, top: 0, width: cropWidth, height: sourceHeight })
      .jpeg({ quality: 92, mozjpeg: true })
      .toBuffer();
    if (sha256(output) !== outputHash) throw new Error(`${context}:OUTPUT_HASH_MISMATCH`);
    const state = existing === "reused" ? existing : await writeNewOutput(absolute, output, context);
    results.push(Object.freeze({ code, mode, source_id: sourceId, output_path: outputPath, state }));
  }
  return Object.freeze({
    input_total: decisions.length,
    transformed_total: results.filter((row) => row.mode !== "PACKAGE_FULL").length,
    full_verified_total: results.filter((row) => row.mode === "PACKAGE_FULL").length,
    created_total: results.filter((row) => row.state === "created").length,
    reused_total: results.filter((row) => row.state === "reused").length,
    fetched_unique_total: downloadCache.size,
    results: Object.freeze(results),
  });
}

export async function runCli(args = process.argv.slice(2)) {
  if (args.some((arg) => arg !== "--write" && arg !== "--check" && !arg.startsWith("--evidence="))) {
    throw new Error("PHASE5_MATERIALIZER:UNKNOWN_ARGUMENT");
  }
  const write = args.includes("--write");
  if (write && args.includes("--check")) throw new Error("PHASE5_MATERIALIZER:AMBIGUOUS_MODE");
  const evidenceArgument = args.find((arg) => arg.startsWith("--evidence="));
  const evidenceFilePath = evidenceArgument
    ? evidenceArgument.slice("--evidence=".length)
    : defaultEvidenceInput;
  if (!evidenceFilePath) throw new Error("PHASE5_MATERIALIZER:EVIDENCE_PATH_REQUIRED");
  const result = await materializePhase5ReviewedAssets({ write, evidenceFilePath });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await runCli();
