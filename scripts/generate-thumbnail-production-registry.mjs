import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalizeProductCodeValue } from "../src/lib/fanza/normalize.ts";
import {
  adaptGoldLabelRecord,
  adaptHumanApprovalRecord,
} from "../src/lib/thumbnail/adapters.ts";
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
const sceneCropPath = path.join(
  root,
  "data",
  "thumbnail-scene-crop-allowlist.csv",
);
const publicDir = path.join(root, "public", "card-thumbnails");
const EXPECTED_SCENE_CROP_ALLOWLIST_COUNT = 29;
const SCENE_CROP_SOURCE_DIRECTORY = "data/thumbnail-scene-crop-sources";
const SCENE_CROP_OUTPUT_WIDTH = 315;
const SCENE_CROP_OUTPUT_HEIGHT = 450;
// Bound untrusted JPEG headers before dimensions can influence crop validation.
const MAX_JPEG_DIMENSION = 16_384;
const MAX_JPEG_PIXELS = 100_000_000;
const SCENE_CROP_VARIANTS = new Set([
  "STANDARD",
  "REVISED",
  "ROTATE_CLOCKWISE_B",
]);
const JPEG_SOF_MARKERS = new Set([
  0xc0,
  0xc1,
  0xc2,
  0xc3,
  0xc5,
  0xc6,
  0xc7,
  0xc9,
  0xca,
  0xcb,
  0xcd,
  0xce,
  0xcf,
]);

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
const SCENE_CROP_KEYS = new Set([
  "unit",
  "x",
  "y",
  "width",
  "height",
  "rotation_degrees",
]);

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

async function readLocalApprovedOutput(
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
  return {
    buffer,
    digest: crypto.createHash("sha256").update(buffer).digest("hex"),
  };
}

async function fileDigestForOutput(
  output,
  options = {},
) {
  const result = await readLocalApprovedOutput(output, options);
  return result?.digest ?? null;
}

function assertedHash(value, context) {
  const normalized = String(value ?? "").trim();
  if (!SHA256.test(normalized)) {
    throw new Error(`${context}:INVALID_SHA256`);
  }
  return normalized.toLowerCase();
}

function requiredText(value, context) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${context}:MISSING_VALUE`);
  return normalized;
}

function repositoryFileFromRelative(value, repositoryDirectory, context) {
  const normalized = requiredText(value, context).replaceAll("\\", "/");
  if (
    normalized.includes("\u0000") ||
    path.posix.isAbsolute(normalized) ||
    path.posix.normalize(normalized) !== normalized ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(`${context}:INVALID_REPOSITORY_PATH`);
  }
  const directory = path.resolve(repositoryDirectory);
  const file = path.resolve(directory, ...normalized.split("/"));
  if (!file.startsWith(`${directory}${path.sep}`)) {
    throw new Error(`${context}:REPOSITORY_PATH_ESCAPE`);
  }
  return { directory, file, relative: normalized };
}

async function verifyRepositoryFile(
  relativePath,
  expectedHash,
  { repositoryDirectory = root, context },
) {
  const local = repositoryFileFromRelative(
    relativePath,
    repositoryDirectory,
    context,
  );
  let info;
  try {
    info = await fs.lstat(local.file);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${context}:MISSING_LOCAL_SOURCE`);
    }
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw new Error(`${context}:SYMLINK_LOCAL_SOURCE`);
  }
  if (!info.isFile()) {
    throw new Error(`${context}:NON_REGULAR_LOCAL_SOURCE`);
  }
  const [realDirectory, realFile] = await Promise.all([
    fs.realpath(local.directory),
    fs.realpath(local.file),
  ]);
  if (!realFile.startsWith(`${realDirectory}${path.sep}`)) {
    throw new Error(`${context}:LOCAL_SOURCE_REALPATH_ESCAPE`);
  }
  const buffer = await fs.readFile(local.file);
  if (!buffer.length) throw new Error(`${context}:EMPTY_LOCAL_SOURCE`);
  const actualHash = crypto.createHash("sha256").update(buffer).digest("hex");
  if (actualHash !== expectedHash) {
    throw new Error(`${context}:LOCAL_SOURCE_HASH_MISMATCH`);
  }
  return {
    ...local,
    buffer,
    dimensions: readJpegDimensions(buffer, context),
  };
}

export function readJpegDimensions(buffer, context = "JPEG") {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    throw new Error(`${context}:INVALID_JPEG`);
  }
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new Error(`${context}:INVALID_JPEG`);
  }

  let offset = 2;
  let dimensions = null;
  let frameComponentIds = null;
  let inScan = false;
  let currentScanHasEntropyData = false;
  const sawSOI = true;
  let sawSOF = false;
  let sawSOS = false;
  let sawEntropyData = false;
  let sawEOI = false;
  let markers = 0;

  while (offset < buffer.length) {
    markers += 1;
    if (markers > buffer.length) {
      throw new Error(`${context}:INVALID_JPEG`);
    }

    let marker;
    if (inScan) {
      if (buffer[offset] !== 0xff) {
        currentScanHasEntropyData = true;
        sawEntropyData = true;
        offset += 1;
        continue;
      }
      offset += 1;
      while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
      if (offset >= buffer.length) break;
      marker = buffer[offset];
      offset += 1;
      if (marker === 0x00) {
        currentScanHasEntropyData = true;
        sawEntropyData = true;
        continue;
      }
      if (marker >= 0xd0 && marker <= 0xd7) continue;
      if (!currentScanHasEntropyData) {
        throw new Error(`${context}:EMPTY_JPEG_SCAN`);
      }
      inScan = false;
    } else {
      if (buffer[offset] !== 0xff) {
        throw new Error(`${context}:INVALID_JPEG`);
      }
      while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
      if (offset >= buffer.length) break;
      marker = buffer[offset];
      offset += 1;
    }

    if (marker === 0xd9) {
      sawEOI = true;
      if (!sawSOI || !sawSOF || !dimensions) {
        throw new Error(`${context}:JPEG_DIMENSIONS_MISSING`);
      }
      if (!sawSOS) throw new Error(`${context}:JPEG_SCAN_MISSING`);
      if (!sawEntropyData) throw new Error(`${context}:EMPTY_JPEG_SCAN`);
      break;
    }
    if (marker === 0xd8) {
      throw new Error(`${context}:DUPLICATE_JPEG_SOI`);
    }
    if (marker === 0x01) {
      continue;
    }
    if (
      marker === 0x00 ||
      (marker >= 0x02 && marker < 0xc0) ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      marker === 0xff
    ) {
      throw new Error(`${context}:INVALID_JPEG_MARKER`);
    }
    if (offset + 2 > buffer.length) throw new Error(`${context}:INVALID_JPEG`);
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) {
      throw new Error(`${context}:INVALID_JPEG`);
    }
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (sawSOF) throw new Error(`${context}:DUPLICATE_JPEG_SOF`);
      if (segmentLength < 11) throw new Error(`${context}:INVALID_JPEG_SOF`);
      const componentCount = buffer[offset + 7];
      if (
        componentCount === 0 ||
        segmentLength !== 8 + 3 * componentCount
      ) {
        throw new Error(`${context}:INVALID_JPEG_SOF`);
      }
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      if (width <= 0 || height <= 0) {
        throw new Error(`${context}:INVALID_JPEG_DIMENSIONS`);
      }
      const pixels = width * height;
      if (
        !Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        !Number.isSafeInteger(pixels) ||
        width > MAX_JPEG_DIMENSION ||
        height > MAX_JPEG_DIMENSION ||
        pixels > MAX_JPEG_PIXELS
      ) {
        throw new Error(`${context}:JPEG_DIMENSIONS_LIMIT_EXCEEDED`);
      }
      frameComponentIds = new Set();
      for (let index = 0; index < componentCount; index += 1) {
        const componentId = buffer[offset + 8 + 3 * index];
        if (frameComponentIds.has(componentId)) {
          throw new Error(`${context}:INVALID_JPEG_SOF`);
        }
        frameComponentIds.add(componentId);
      }
      dimensions = { width, height };
      sawSOF = true;
    } else if (marker === 0xda) {
      if (!sawSOF || !frameComponentIds) {
        throw new Error(`${context}:JPEG_SOS_BEFORE_SOF`);
      }
      if (segmentLength < 8) throw new Error(`${context}:INVALID_JPEG_SOS`);
      const componentCount = buffer[offset + 2];
      if (
        componentCount === 0 ||
        segmentLength !== 6 + 2 * componentCount
      ) {
        throw new Error(`${context}:INVALID_JPEG_SOS`);
      }
      const scanComponentIds = new Set();
      for (let index = 0; index < componentCount; index += 1) {
        const componentId = buffer[offset + 3 + 2 * index];
        if (
          !frameComponentIds.has(componentId) ||
          scanComponentIds.has(componentId)
        ) {
          throw new Error(`${context}:INVALID_JPEG_SOS`);
        }
        scanComponentIds.add(componentId);
      }
      sawSOS = true;
    }
    const segmentEnd = offset + segmentLength;
    offset = segmentEnd;
    if (marker === 0xda) {
      inScan = true;
      currentScanHasEntropyData = false;
    }
  }

  if (!sawEOI) throw new Error(`${context}:TRUNCATED_JPEG`);
  return dimensions;
}

function parseSceneCropSpec(value, context) {
  let crop;
  try {
    crop = JSON.parse(requiredText(value, `${context}:CROP_SPEC`));
  } catch (error) {
    throw new Error(`${context}:INVALID_CROP_SPEC_JSON`, { cause: error });
  }
  if (!crop || typeof crop !== "object" || Array.isArray(crop)) {
    throw new Error(`${context}:INVALID_CROP_SPEC`);
  }
  const keys = Object.keys(crop);
  if (keys.some((key) => !SCENE_CROP_KEYS.has(key))) {
    throw new Error(`${context}:UNSUPPORTED_CROP_SPEC_FIELD`);
  }
  const values = [crop.x, crop.y, crop.width, crop.height];
  if (
    crop.unit !== "pixel" ||
    !values.every(Number.isSafeInteger) ||
    crop.x < 0 ||
    crop.y < 0 ||
    crop.width <= 0 ||
    crop.height <= 0
  ) {
    throw new Error(`${context}:INVALID_CROP_SPEC`);
  }
  if (
    crop.rotation_degrees !== undefined &&
    ![0, 90, 180, 270].includes(crop.rotation_degrees)
  ) {
    throw new Error(`${context}:INVALID_CROP_ROTATION`);
  }
  return crop;
}

function validateSceneCropBounds(crop, dimensions, context) {
  const rotation = crop.rotation_degrees ?? 0;
  const rotated = rotation === 90 || rotation === 270;
  const width = rotated ? dimensions.height : dimensions.width;
  const height = rotated ? dimensions.width : dimensions.height;
  const right = crop.x + crop.width;
  const bottom = crop.y + crop.height;
  if (!Number.isSafeInteger(right) || !Number.isSafeInteger(bottom)) {
    throw new Error(`${context}:CROP_COORDINATE_OVERFLOW`);
  }
  if (right > width || bottom > height) {
    throw new Error(
      `${context}:CROP_OUT_OF_BOUNDS:${crop.x},${crop.y},${crop.width},${crop.height}:${width}x${height}`,
    );
  }
}

function expectedScenePlUrl(code) {
  const slug = code.toLowerCase();
  return `https://pics.dmm.co.jp/digital/video/${slug}/${slug}pl.jpg`;
}

async function materializeSceneCropRecord({
  row,
  human,
  publicDirectory,
  repositoryDirectory,
}) {
  const code = canonicalCode(row.code, "SCENE_CROP");
  const context = `SCENE_CROP:${code}`;
  if (
    row.mode !== "SCENE_CROP" ||
    row.source_id !== "scene:pl" ||
    row.source_kind !== "SCENE" ||
    row.object_fit !== "scale-down" ||
    row.approval_status !== "HUMAN_APPROVED" ||
    row.render_status !== "READY"
  ) {
    throw new Error(`${context}:INVALID_FIXED_CONTRACT`);
  }
  const sourcePath = requiredText(row.source_path_or_url, `${context}:SOURCE_URL`);
  if (sourcePath !== expectedScenePlUrl(code)) {
    throw new Error(`${context}:UNCONFIRMED_SCENE_PL_SOURCE`);
  }
  const sourceHash = assertedHash(row.source_hash, `${context}:SOURCE_HASH`);
  const expectedSourcePath = `${SCENE_CROP_SOURCE_DIRECTORY}/${code}-scene-pl-${sourceHash.slice(0, 16)}.jpg`;
  if (row.source_local_path !== expectedSourcePath) {
    throw new Error(`${context}:SOURCE_BUNDLE_PATH_MISMATCH`);
  }
  const outputHash = assertedHash(row.output_hash, `${context}:OUTPUT_HASH`);
  const output = requiredText(row.output_path_or_url, `${context}:OUTPUT`);
  if (output !== `/card-thumbnails/${code}-scene-portrait-v4.jpg`) {
    throw new Error(`${context}:UNEXPECTED_APPROVED_OUTPUT`);
  }
  const approvedBy = requiredText(row.approved_by, `${context}:APPROVED_BY`);
  const approvedAt = requiredText(row.approved_at, `${context}:APPROVED_AT`);
  const reason = requiredText(row.reason, `${context}:REASON`);
  const cropSpec = parseSceneCropSpec(row.crop_spec, context);
  const cropVariant = requiredText(row.crop_variant, `${context}:CROP_VARIANT`);
  if (!SCENE_CROP_VARIANTS.has(cropVariant)) {
    throw new Error(`${context}:INVALID_CROP_VARIANT`);
  }
  const rotation = cropSpec.rotation_degrees ?? 0;
  if (cropVariant === "ROTATE_CLOCKWISE_B") {
    if (code !== "1SBP00424" || rotation !== 90) {
      throw new Error(`${context}:ROTATION_VARIANT_MISMATCH`);
    }
  } else if (rotation !== 0) {
    throw new Error(`${context}:UNEXPECTED_CROP_ROTATION`);
  }

  if (!human) throw new Error(`${context}:MISSING_HUMAN_APPROVAL`);
  const acceptedSourceId = String(human.accepted_source_id ?? "").trim();
  if (
    !new Set(["CURRENT_OK", "APPROVE_CLUSTER_CURRENT"]).has(
      String(human.decision ?? "").trim(),
    ) ||
    String(human.accepted_mode ?? "").trim() !== "scene_portrait" ||
    !new Set([
      "scene_portrait",
      "scene_portrait:revised",
      "scene_portrait:rotate_clockwise_b",
    ]).has(acceptedSourceId) ||
    publicOutputFromPath(human.accepted_image_path) !== output ||
    assertedHash(human.accepted_image_hash, `${context}:HUMAN_OUTPUT_HASH`) !==
      outputHash ||
    String(human.approved_at ?? "").trim() !== approvedAt
  ) {
    throw new Error(`${context}:HUMAN_APPROVAL_MISMATCH`);
  }

  const sourceFile = await verifyRepositoryFile(row.source_local_path, sourceHash, {
    repositoryDirectory,
    context,
  });
  validateSceneCropBounds(cropSpec, sourceFile.dimensions, context);
  const approvedOutput = await verifyLocalApprovedOutput(
    output,
    outputHash,
    context,
    publicDirectory,
  );
  const outputDimensions = readJpegDimensions(
    approvedOutput.buffer,
    `${context}:APPROVED_OUTPUT`,
  );
  if (
    outputDimensions.width !== SCENE_CROP_OUTPUT_WIDTH ||
    outputDimensions.height !== SCENE_CROP_OUTPUT_HEIGHT
  ) {
    throw new Error(
      `${context}:APPROVED_OUTPUT_DIMENSIONS_MISMATCH:${outputDimensions.width}x${outputDimensions.height}`,
    );
  }

  const record = {
    code,
    mode: "SCENE_CROP",
    state: "RESOLVED",
    source_id: "scene:pl",
    source_path_or_url: sourcePath,
    source_hash: sourceHash,
    output_path_or_url: output,
    output_hash: outputHash,
    crop_spec: cropSpec,
    approved_by: approvedBy,
    approved_at: approvedAt,
    reason,
  };
  adaptHumanApprovalRecord(record);
  return record;
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
  if (!output.startsWith("/card-thumbnails/")) return null;
  const approvedOutput = await readLocalApprovedOutput(output, {
    publicDirectory,
    context,
  });
  if (approvedOutput.digest !== expectedHash) {
    throw new Error(`${context}:APPROVED_OUTPUT_HASH_MISMATCH`);
  }
  return approvedOutput;
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
  sceneCropFilePath = sceneCropPath,
  publicDirectory = publicDir,
  repositoryDirectory = root,
  expectedSceneCropCount = EXPECTED_SCENE_CROP_ALLOWLIST_COUNT,
  fixedDecisions = PRODUCTION_CANONICAL_THUMBNAIL_DECISIONS,
} = {}) {
  const goldText = await fs.readFile(goldFilePath, "utf8");
  const humanText = await fs.readFile(humanFilePath, "utf8");
  const overridesText = await fs.readFile(overridesFilePath, "utf8");
  const sceneCropText = await fs.readFile(sceneCropFilePath, "utf8");
  const goldRows = parseCsv(goldText);
  const humanRows = parseCsv(humanText);
  const sceneCropRows = parseCsv(sceneCropText);
  const overrides = JSON.parse(overridesText);
  const { humanByCode } = buildCanonicalHumanMap(humanRows);

  if (sceneCropRows.length !== expectedSceneCropCount) {
    throw new Error(
      `SCENE_CROP_ALLOWLIST_COUNT_MISMATCH:${sceneCropRows.length}:${expectedSceneCropCount}`,
    );
  }

  const stats = {
    gold_total: goldRows.length,
    gold_registry_adopted: 0,
    gold_pending: 0,
    gold_excluded_unsupported_mode: 0,
    gold_excluded_invalid_source: 0,
    human_total: humanRows.length,
    human_registry_adopted: 0,
    human_covered_by_fixed: 0,
    human_covered_by_scene_crop_allowlist: 0,
    human_excluded_current_ok: 0,
    human_excluded_pattern_or_cluster: 0,
    human_excluded_source_or_provenance: 0,
    alias_rejected: 0,
    duplicate_canonical_codes: 0,
    fixed_shadowed: 0,
    conflicts: 0,
    scene_crop_allowlist_total: sceneCropRows.length,
    scene_crop_registry_adopted: 0,
    scene_crop_standard: 0,
    scene_crop_revised: 0,
    scene_crop_rotate_clockwise_b: 0,
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
  const sceneCropCodes = new Set();
  for (const row of sceneCropRows) {
    const code = canonicalCode(row.code, "SCENE_CROP");
    if (sceneCropCodes.has(code)) {
      stats.duplicate_canonical_codes += 1;
      throw new Error(`SCENE_CROP_CANONICAL_DUPLICATE:${code}`);
    }
    if (fixedDecisions.has(code) || goldCodes.has(code)) {
      stats.conflicts += 1;
      throw new Error(`SCENE_CROP_CANONICAL_CONFLICT:${code}`);
    }
    sceneCropCodes.add(code);
    if (row.crop_variant === "STANDARD") stats.scene_crop_standard += 1;
    if (row.crop_variant === "REVISED") stats.scene_crop_revised += 1;
    if (row.crop_variant === "ROTATE_CLOCKWISE_B") {
      stats.scene_crop_rotate_clockwise_b += 1;
    }
    humanRecords.push(
      await materializeSceneCropRecord({
        row,
        human: humanByCode.get(code)?.row ?? null,
        publicDirectory,
        repositoryDirectory,
      }),
    );
  }
  stats.scene_crop_registry_adopted = humanRecords.length;

  for (const row of humanRows) {
    const normalized = canonicalizeProductCodeValue(row.code);
    if (normalized.canonical && sceneCropCodes.has(normalized.canonical)) {
      stats.human_covered_by_scene_crop_allowlist += 1;
      continue;
    }
    const decision = String(row.decision ?? "").trim().toUpperCase();
    if (decision === "CURRENT_OK") {
      stats.human_excluded_current_ok += 1;
      continue;
    }
    if (!EXPLICIT_HUMAN_DECISIONS.has(decision)) {
      stats.human_excluded_pattern_or_cluster += 1;
      continue;
    }
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
    scene_crop_allowlist_sha256: crypto
      .createHash("sha256")
      .update(sceneCropText)
      .digest("hex"),
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
