import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalizeProductCodeValue } from "../src/lib/fanza/normalize.ts";
import { adaptGoldLabelRecord } from "../src/lib/thumbnail/adapters.ts";
import { PRODUCTION_CANONICAL_THUMBNAIL_DECISIONS } from "../src/lib/thumbnail/canonical-decisions.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generatedPath = path.join(
  root,
  "src",
  "lib",
  "thumbnail",
  "generated-approved-decisions.ts",
);
const goldPath = path.join(root, "data", "thumbnail-gold-labels.csv");
const humanPath = path.join(root, "data", "thumbnail-human-approvals.csv");
const overridesPath = path.join(root, "data", "thumbnail-local-overrides.json");
const publicDir = path.join(root, "public", "card-thumbnails");

const MODE_MAP = Object.freeze({
  sample: "SAMPLE",
  right: "PACKAGE_RIGHT",
  full: "PACKAGE_FULL",
  center: "PACKAGE_CENTER",
});
const SOURCE_PATTERNS = Object.freeze({
  SAMPLE: /^sample:[1-9]\d*$/,
  PACKAGE_RIGHT: /^dvd:right$/,
  PACKAGE_FULL: /^dvd:full$/,
  PACKAGE_CENTER: /^dvd:center$/,
});
const GOLD_SOURCE_ID_ALLOWLIST = new Map([
  ["DSVR00064\u0000sample:1_high_resolution", "sample:1"],
]);
const EXPLICIT_HUMAN_DECISIONS = new Set([
  "SAMPLE",
  "RIGHT",
  "FULL",
  "CENTER",
  "SCENE_FULL",
  "SCENE_CROP",
]);
const SHA256 = /^[a-f0-9]{64}$/i;

export function compareAscii(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function parseCsv(text) {
  const records = [];
  let field = "";
  let row = [];
  let quoted = false;
  const pushField = () => {
    row.push(field);
    field = "";
  };
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

  const [header = [], ...rows] = records;
  return rows
    .filter((values) => values.some((value) => value.trim()))
    .map((values) =>
      Object.fromEntries(
        header.map((name, index) => [
          name.replace(/^\uFEFF/, ""),
          values[index] ?? "",
        ]),
      ),
    );
}

function canonicalCode(value, context) {
  const result = canonicalizeProductCodeValue(value);
  if (!result.canonical || result.rejected) {
    throw new Error(
      `${context}:INVALID_CANONICAL_CODE:${String(value)}:${result.rejectionReason ?? ""}`,
    );
  }
  return result.canonical;
}

export function canonicalGoldSourceId(code, rawSourceId) {
  return GOLD_SOURCE_ID_ALLOWLIST.get(`${code}\u0000${rawSourceId}`) ?? rawSourceId;
}

function publicOutputFromPath(value) {
  const normalized = String(value ?? "").trim().replaceAll("\\", "/");
  if (normalized.startsWith("public/card-thumbnails/")) {
    return `/${normalized.slice("public/".length)}`;
  }
  if (normalized.startsWith("/card-thumbnails/")) return normalized;
  if (/^https:\/\/pics\.dmm\.co\.jp\//.test(normalized)) return normalized;
  return null;
}

function sourcePathFromOutput(output) {
  return output.startsWith("/card-thumbnails/")
    ? `public${output}`
    : output;
}

function strictGoldOutput(code, mode, sourceId) {
  if (mode === "PACKAGE_RIGHT") {
    return `/card-thumbnails/${code}-auto-right.jpg`;
  }
  if (mode === "PACKAGE_CENTER") {
    return `/card-thumbnails/${code}-auto-center.jpg`;
  }
  if (mode === "PACKAGE_FULL") {
    return `/card-thumbnails/${code}-gold-full.jpg`;
  }
  const sample = /^sample:(\d+)$/.exec(sourceId);
  return sample
    ? `/card-thumbnails/${code}-gold-sample-${sample[1]}.jpg`
    : null;
}

function localApprovedFile(output, publicDirectory) {
  if (!output.startsWith("/card-thumbnails/")) return null;
  const relative = output.slice("/card-thumbnails/".length);
  if (
    !relative ||
    relative.includes("\u0000") ||
    relative.includes("\\") ||
    path.posix.isAbsolute(relative) ||
    path.posix.normalize(relative) !== relative ||
    relative.split("/").includes("..")
  ) {
    throw new Error(`INVALID_APPROVED_OUTPUT_PATH:${output}`);
  }
  const directory = path.resolve(publicDirectory);
  const file = path.resolve(directory, ...relative.split("/"));
  if (!file.startsWith(`${directory}${path.sep}`)) {
    throw new Error(`APPROVED_OUTPUT_PATH_ESCAPE:${output}`);
  }
  return { directory, file };
}

async function fileDigestForOutput(
  output,
  { publicDirectory = publicDir, context = "APPROVED_OUTPUT" } = {},
) {
  const local = localApprovedFile(output, publicDirectory);
  if (!local) return null;
  const info = await fs.lstat(local.file);
  if (info.isSymbolicLink()) {
    throw new Error(`${context}:SYMLINK_APPROVED_OUTPUT:${output}`);
  }
  if (!info.isFile()) {
    throw new Error(`${context}:NON_REGULAR_APPROVED_OUTPUT:${output}`);
  }
  const [realDirectory, realFile] = await Promise.all([
    fs.realpath(local.directory),
    fs.realpath(local.file),
  ]);
  if (!realFile.startsWith(`${realDirectory}${path.sep}`)) {
    throw new Error(`${context}:APPROVED_OUTPUT_REALPATH_ESCAPE:${output}`);
  }
  const buffer = await fs.readFile(local.file);
  if (!buffer.length) throw new Error(`${context}:EMPTY_APPROVED_OUTPUT:${output}`);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function assertedHash(value, context) {
  const normalized = String(value ?? "").trim();
  if (!SHA256.test(normalized)) {
    throw new Error(`${context}:INVALID_SHA256`);
  }
  return normalized.toLowerCase();
}

function goldReason(row, rawSourceId, sourceId) {
  const basis = String(row.decision_basis ?? "").trim();
  const notes = String(row.notes ?? "").trim();
  return [
    "Generated from data/thumbnail-gold-labels.csv",
    rawSourceId !== sourceId && `raw_source_id=${rawSourceId}`,
    rawSourceId !== sourceId && `canonical_source_id=${sourceId}`,
    basis && `basis=${basis}`,
    notes && `notes=${notes}`,
  ].filter(Boolean).join("; ");
}

async function verifyLocalApprovedOutput(
  output,
  expectedHash,
  context,
  publicDirectory,
) {
  if (!output.startsWith("/card-thumbnails/")) return;
  const actualHash = await fileDigestForOutput(output, {
    publicDirectory,
    context,
  });
  if (actualHash !== expectedHash) {
    throw new Error(`${context}:APPROVED_OUTPUT_HASH_MISMATCH`);
  }
}

async function materializeGoldRecord({
  row,
  code,
  mode,
  sourceId,
  rawSourceId,
  override,
  human,
  publicDirectory,
}) {
  let sourcePath = null;
  let sourceHash = null;
  let output = null;
  let outputHash = null;

  if (override) {
    if (
      String(override.mode ?? "").trim().toLowerCase() !==
        String(row.expected_type ?? "").trim().toLowerCase() ||
      !new Set([sourceId, rawSourceId]).has(String(override.sourceId ?? "").trim())
    ) {
      throw new Error(`GOLD_OVERRIDE_CONFLICT:${code}`);
    }
    output = publicOutputFromPath(override.path);
    if (!output) throw new Error(`GOLD_OVERRIDE_INVALID_OUTPUT:${code}`);
    outputHash = assertedHash(override.sha256, `GOLD_OVERRIDE:${code}`);
    sourcePath = sourcePathFromOutput(output);
    sourceHash = outputHash;
    await verifyLocalApprovedOutput(
      output,
      outputHash,
      `GOLD_OVERRIDE:${code}`,
      publicDirectory,
    );
  } else if (
    human &&
    String(human.accepted_mode ?? "").trim().toLowerCase() ===
      String(row.expected_type ?? "").trim().toLowerCase() &&
    new Set([sourceId, rawSourceId]).has(
      String(human.accepted_source_id ?? "").trim(),
    )
  ) {
    sourcePath = String(human.accepted_image_path ?? "").trim() || null;
    sourceHash = assertedHash(human.accepted_image_hash, `GOLD_HUMAN_SOURCE:${code}`);
    output = publicOutputFromPath(sourcePath);
    if (output) {
      outputHash = sourceHash;
      await verifyLocalApprovedOutput(
        output,
        outputHash,
        `GOLD_HUMAN_SOURCE:${code}`,
        publicDirectory,
      );
    }
  } else {
    output = strictGoldOutput(code, mode, sourceId);
    if (!output) throw new Error(`GOLD_OUTPUT_CONVENTION_UNAVAILABLE:${code}`);
    outputHash = await fileDigestForOutput(output, {
      publicDirectory,
      context: `GOLD_CONVENTION:${code}`,
    });
    sourcePath = sourcePathFromOutput(output);
    sourceHash = outputHash;
  }

  const base = {
    code,
    mode,
    source_id: sourceId,
    source_path_or_url: sourcePath,
    source_hash: sourceHash,
    approved_by: null,
    approved_at: null,
    reason: goldReason(row, rawSourceId, sourceId),
  };
  const record = output
    ? {
        ...base,
        state: "RESOLVED",
        output_path_or_url: output,
        output_hash: outputHash,
      }
    : {
        ...base,
        state: "PENDING_OUTPUT",
        output_path_or_url: null,
        output_hash: null,
      };
  adaptGoldLabelRecord(record);
  return record;
}

function stableGeneratedSource({ goldRecords, humanRecords, stats, inputs }) {
  return `/* This file is generated by scripts/generate-thumbnail-production-registry.mjs. */
/* Do not edit it by hand. It is static and safe for client bundles. */

import type { CanonicalDecisionRecord } from "./adapters.ts";

export const GENERATED_GOLD_DECISION_RECORDS = Object.freeze(
  ${JSON.stringify(goldRecords, null, 2)} as const satisfies readonly CanonicalDecisionRecord[],
);

export const GENERATED_HUMAN_DECISION_RECORDS = Object.freeze(
  ${JSON.stringify(humanRecords, null, 2)} as const satisfies readonly CanonicalDecisionRecord[],
);

export const GENERATED_APPROVED_REGISTRY_STATS = Object.freeze(
  ${JSON.stringify(stats, null, 2)} as const,
);

export const GENERATED_APPROVED_REGISTRY_INPUTS = Object.freeze(
  ${JSON.stringify(inputs, null, 2)} as const,
);
`;
}

export function buildCanonicalHumanMap(humanRows) {
  const humanByCode = new Map();
  const rejectedRows = [];
  for (const row of humanRows) {
    const rawCode = String(row.code ?? "").trim();
    if (!rawCode) throw new Error("HUMAN_APPROVAL_MISSING_CODE");
    const normalized = canonicalizeProductCodeValue(rawCode);
    if (!normalized.canonical || normalized.rejected) {
      rejectedRows.push(row);
      continue;
    }
    const existing = humanByCode.get(normalized.canonical);
    if (existing) {
      throw new Error(
        `HUMAN_APPROVAL_CANONICAL_COLLISION:${normalized.canonical}:${existing.rawCode}:${rawCode}`,
      );
    }
    humanByCode.set(normalized.canonical, { rawCode, row });
  }
  return { humanByCode, rejectedRows };
}

export async function generateSource({
  goldFilePath = goldPath,
  humanFilePath = humanPath,
  overridesFilePath = overridesPath,
  publicDirectory = publicDir,
  fixedDecisions = PRODUCTION_CANONICAL_THUMBNAIL_DECISIONS,
} = {}) {
  const goldText = await fs.readFile(goldFilePath, "utf8");
  const humanText = await fs.readFile(humanFilePath, "utf8");
  const overridesText = await fs.readFile(overridesFilePath, "utf8");
  const goldRows = parseCsv(goldText);
  const humanRows = parseCsv(humanText);
  const overrides = JSON.parse(overridesText);
  const { humanByCode } = buildCanonicalHumanMap(humanRows);

  const stats = {
    gold_total: goldRows.length,
    gold_registry_adopted: 0,
    gold_pending: 0,
    gold_excluded_unsupported_mode: 0,
    gold_excluded_invalid_source: 0,
    human_total: humanRows.length,
    human_registry_adopted: 0,
    human_covered_by_fixed: 0,
    human_excluded_current_ok: 0,
    human_excluded_pattern_or_cluster: 0,
    human_excluded_source_or_provenance: 0,
    alias_rejected: 0,
    duplicate_canonical_codes: 0,
    fixed_shadowed: 0,
    conflicts: 0,
  };
  const goldRecords = [];
  const goldCodes = new Set();

  for (const row of goldRows) {
    const rawMode = String(row.expected_type ?? "").trim().toLowerCase();
    const mode = MODE_MAP[rawMode];
    if (!mode) {
      stats.gold_excluded_unsupported_mode += 1;
      continue;
    }
    const code = canonicalCode(row.product_code, "GOLD");
    const rawSourceId = String(row.expected_source ?? "").trim();
    const sourceId = canonicalGoldSourceId(code, rawSourceId);
    if (!SOURCE_PATTERNS[mode].test(sourceId)) {
      stats.gold_excluded_invalid_source += 1;
      continue;
    }
    if (goldCodes.has(code)) {
      stats.duplicate_canonical_codes += 1;
      throw new Error(`GOLD_CANONICAL_DUPLICATE:${code}`);
    }
    goldCodes.add(code);

    const human = humanByCode.get(code)?.row ?? null;
    const record = await materializeGoldRecord({
      row,
      code,
      mode,
      sourceId,
      rawSourceId,
      override: overrides[code] ?? null,
      human,
      publicDirectory,
    });
    const fixed = fixedDecisions.get(code);
    if (fixed) {
      stats.fixed_shadowed += 1;
      if (fixed.mode !== record.mode || fixed.source_id !== record.source_id) {
        stats.conflicts += 1;
        throw new Error(`FIXED_GOLD_CONFLICT:${code}`);
      }
    }
    if (record.state !== "RESOLVED") stats.gold_pending += 1;
    goldRecords.push(record);
  }
  stats.gold_registry_adopted = goldRecords.length;

  const humanRecords = [];
  for (const row of humanRows) {
    const decision = String(row.decision ?? "").trim().toUpperCase();
    if (decision === "CURRENT_OK") {
      stats.human_excluded_current_ok += 1;
      continue;
    }
    if (!EXPLICIT_HUMAN_DECISIONS.has(decision)) {
      stats.human_excluded_pattern_or_cluster += 1;
      continue;
    }
    const normalized = canonicalizeProductCodeValue(row.code);
    if (!normalized.canonical || normalized.rejected) {
      stats.alias_rejected += 1;
      continue;
    }
    const fixed = fixedDecisions.get(normalized.canonical);
    if (
      fixed &&
      String(row.accepted_mode ?? "").trim().toLowerCase() ===
        String(fixed.mode).replace(/^PACKAGE_/, "").toLowerCase() &&
      String(row.accepted_source_id ?? "").trim() === fixed.source_id &&
      String(row.accepted_image_hash ?? "").trim().toLowerCase() === fixed.output_hash
    ) {
      stats.human_covered_by_fixed += 1;
      continue;
    }
    stats.human_excluded_source_or_provenance += 1;
  }

  goldRecords.sort((left, right) => compareAscii(left.code, right.code));
  humanRecords.sort((left, right) => compareAscii(left.code, right.code));
  stats.human_registry_adopted = humanRecords.length;

  // Exact byte-level provenance is intentionally order-sensitive. Decision
  // determinism is enforced independently by sorting the normalized records.
  const rawInputByteDigests = {
    gold_sha256: crypto.createHash("sha256").update(goldText).digest("hex"),
    human_sha256: crypto.createHash("sha256").update(humanText).digest("hex"),
    overrides_sha256: crypto.createHash("sha256").update(overridesText).digest("hex"),
  };
  return {
    source: stableGeneratedSource({
      goldRecords,
      humanRecords,
      stats,
      inputs: rawInputByteDigests,
    }),
    stats,
    goldRecords,
    humanRecords,
    rawInputByteDigests,
  };
}

function attachCleanupError(primaryError, cleanupError) {
  if (
    primaryError !== null &&
    (typeof primaryError === "object" || typeof primaryError === "function")
  ) {
    try {
      Object.defineProperty(primaryError, "cleanupError", {
        value: cleanupError,
        configurable: true,
      });
      return primaryError;
    } catch {
      // Fall through to an AggregateError when the primary value is immutable.
    }
  }
  return new AggregateError(
    [primaryError, cleanupError],
    "Atomic registry write and temporary-file cleanup both failed",
    { cause: primaryError },
  );
}

export async function writeFileAtomically(
  targetPath,
  source,
  { filesystem = fs, randomBytes = crypto.randomBytes } = {},
) {
  const directory = path.dirname(targetPath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(targetPath)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
  );
  let handle = null;
  let primaryError = null;
  let hasPrimaryError = false;
  const cleanupErrors = [];
  try {
    handle = await filesystem.open(temporaryPath, "wx", 0o644);
    await handle.writeFile(source, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await filesystem.rename(temporaryPath, targetPath);
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await filesystem.unlink(temporaryPath);
    } catch (error) {
      if (error?.code !== "ENOENT") cleanupErrors.push(error);
    }
  }

  const cleanupError =
    cleanupErrors.length === 0
      ? null
      : cleanupErrors.length === 1
        ? cleanupErrors[0]
        : new AggregateError(
            cleanupErrors,
            "Multiple temporary-file cleanup operations failed",
          );
  if (hasPrimaryError) {
    throw cleanupError
      ? attachCleanupError(primaryError, cleanupError)
      : primaryError;
  }
  if (cleanupError) throw cleanupError;
}

export async function writeGeneratedRegistry({
  targetPath = generatedPath,
  generatorOptions,
} = {}) {
  const result = await generateSource(generatorOptions);
  await writeFileAtomically(targetPath, result.source);
  return result;
}

export async function runCli(args = process.argv.slice(2)) {
  const result = await generateSource();
  if (args.includes("--write")) {
    await writeFileAtomically(generatedPath, result.source);
  } else if (args.includes("--check")) {
    const existing = await fs.readFile(generatedPath, "utf8");
    if (existing !== result.source) {
      throw new Error("THUMBNAIL_PRODUCTION_REGISTRY_OUT_OF_SYNC");
    }
  } else {
    process.stdout.write(result.source);
  }
  console.error(JSON.stringify(result.stats));
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await runCli();
}
