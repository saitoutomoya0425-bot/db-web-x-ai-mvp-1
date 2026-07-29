/**
 * Offline, targeted local asset sync for reviewed gold-label mismatches.
 *
 * This script deliberately reads only the 12 codes in the mismatch CSV. It
 * never connects to Supabase, fetches a URL, or changes card_thumbnail_url.
 * It archives each current asset, produces exactly one deterministic public
 * asset per requested code, and records a compact verification report.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadThumbnailGoldLabels } from "./lib/thumbnail-gold-acceptance.mjs";

const root = process.cwd();
const publicDir = path.join(root, "public", "card-thumbnails");
const auditDir = path.join(root, "tmp", "card-thumbnail-reaudit");
const mismatchCsv = path.join(auditDir, "gold-validation", "gold-label-mismatches.csv");
const auditCsv = path.join(auditDir, "all-audit.csv");
const archiveDir = path.join(auditDir, "archive", "before-production-sync");
const reportDir = path.join(auditDir, "gold-validation", "production-sync");
const cacheDirs = [
  path.join(root, "tmp", "card-thumbnail-v3-dry-run", "cache"),
  path.join(root, "tmp", "card-thumbnail-v2-dry-run", "cache"),
];
const RIGHT_COVER_CARD_RATIO = 0.735;
const apply = process.argv.includes("--apply");
const execFileAsync = promisify(execFile);
const pythonBin = process.env.THUMBNAIL_PYTHON || "python3";

function parseCsv(text) {
  const records = [];
  let field = "";
  let row = [];
  let quoted = false;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { if (row.length || field) { pushField(); records.push(row); } row = []; };
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
  const [header = [], ...rows] = records;
  return rows.filter((values) => values.some((value) => value.trim()))
    .map((values) => Object.fromEntries(header.map((name, index) => [name.replace(/^\uFEFF/, ""), values[index] ?? ""])));
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function sha256(file) {
  return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

function cacheNamesForUrl(url) {
  if (url.startsWith("/card-thumbnails/")) return [path.join(publicDir, path.basename(url))];
  if (!url.startsWith("https://")) return [];
  const extension = path.extname(new URL(url).pathname) || ".jpg";
  const file = `${crypto.createHash("sha1").update(url).digest("hex")}${extension}`;
  return cacheDirs.map((dir) => path.join(dir, file));
}

async function resolveCached(url) {
  for (const candidate of cacheNamesForUrl(url)) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.size > 1024) return candidate;
    } catch {
      // Continue to the next offline cache only.
    }
  }
  return null;
}

function sampleUrl(thumbnailUrl, index) {
  if (!thumbnailUrl?.endsWith("pl.jpg")) return null;
  return `${thumbnailUrl.slice(0, -"pl.jpg".length)}jp-${index}.jpg`;
}

function sampleIndex(source) {
  const match = /^sample:(\d+)(?:_|$)/.exec(source);
  return match ? Number(match[1]) : null;
}

function destinationFor(code, label) {
  if (label.type === "right") return path.join(publicDir, `${code}-auto-right.jpg`);
  if (label.type === "center") return path.join(publicDir, `${code}-auto-center.jpg`);
  if (label.type === "full") return path.join(publicDir, `${code}-gold-full.jpg`);
  if (label.type === "sample") {
    const index = sampleIndex(label.source);
    if (!index) throw new Error(`GOLD_SAMPLE_INDEX_MISSING:${code}:${label.source}`);
    return path.join(publicDir, `${code}-gold-sample-${index}.jpg`);
  }
  throw new Error(`UNSUPPORTED_GOLD_TYPE:${code}:${label.type}`);
}

function sourceUrlFor(row, label) {
  if (label.type === "right" || label.type === "center" || label.type === "full") return row.thumbnail_url;
  if (label.type === "sample") return sampleUrl(row.thumbnail_url, sampleIndex(label.source));
  return null;
}

async function copyIfNew(source, destination) {
  try {
    const [sourceHash, destinationHash] = await Promise.all([sha256(source), sha256(destination)]);
    if (sourceHash === destinationHash) return false;
  } catch {
    // Destination is absent or differs: write the planned source below.
  }
  await fs.copyFile(source, destination);
  return true;
}

async function crop(source, destination, type) {
  const metadata = await imageMetadata(source);
  if (!metadata.width || !metadata.height) throw new Error(`INVALID_SOURCE_DIMENSIONS:${source}`);
  const cropWidth = Math.max(1, Math.min(metadata.width, Math.round(metadata.height * RIGHT_COVER_CARD_RATIO)));
  const left = type === "right" ? metadata.width - cropWidth : Math.round((metadata.width - cropWidth) / 2);
  const program = [
    "from PIL import Image",
    "import sys",
    "src, dest, left, width, height = sys.argv[1:6]",
    "with Image.open(src) as image:",
    "    image.crop((int(left), 0, int(left) + int(width), int(height))).convert('RGB').save(dest, 'JPEG', quality=92, optimize=True)",
  ].join("\n");
  await execFileAsync(pythonBin, [program ? "-c" : "", program, source, destination, String(Math.max(0, left)), String(cropWidth), String(metadata.height)]);
  return { width: cropWidth, height: metadata.height, crop_left: Math.max(0, left) };
}

async function imageMetadata(file) {
  try {
    const program = [
      "from PIL import Image",
      "import json, sys",
      "with Image.open(sys.argv[1]) as image:",
      "    print(json.dumps({'width': image.width, 'height': image.height}))",
    ].join("\n");
    const { stdout } = await execFileAsync(pythonBin, ["-c", program, file]);
    return JSON.parse(stdout);
  } catch {
    return { width: 0, height: 0 };
  }
}

async function writeCsv(file, rows) {
  const headers = Object.keys(rows[0] ?? {});
  await fs.writeFile(file, `${headers.join(",")}\n${rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")).join("\n")}\n`);
}

async function main() {
  const [mismatches, auditRows, labels] = await Promise.all([
    fs.readFile(mismatchCsv, "utf8").then(parseCsv),
    fs.readFile(auditCsv, "utf8").then(parseCsv),
    loadThumbnailGoldLabels(root),
  ]);
  if (mismatches.length !== 12) throw new Error(`MISMATCH_TARGET_COUNT:${mismatches.length}`);
  const codes = mismatches.map((row) => row.product_code);
  if (new Set(codes).size !== 12) throw new Error("MISMATCH_TARGET_DUPLICATE_CODE");
  const byCode = new Map(auditRows.map((row) => [row.product_code, row]));
  await fs.mkdir(archiveDir, { recursive: true });
  await fs.mkdir(reportDir, { recursive: true });

  const plan = [];
  for (const code of codes) {
    const row = byCode.get(code);
    const label = labels.get(code);
    if (!row || !label) throw new Error(`TARGET_DATA_MISSING:${code}`);
    const sourceUrl = sourceUrlFor(row, label);
    const source = sourceUrl ? await resolveCached(sourceUrl) : null;
    const current = row.current_card_thumbnail_url;
    const currentPath = current ? await resolveCached(current) : null;
    const destination = destinationFor(code, label);
    if (!source || !currentPath) throw new Error(`BLOCKER_SOURCE_UNAVAILABLE:${code}:${!source ? "gold_source" : "current_source"}`);
    plan.push({ code, row, label, sourceUrl, source, current, currentPath, destination });
  }

  const preflight = plan.map((item) => ({
    product_code: item.code,
    expected_type: item.label.type,
    expected_source: item.label.source,
    current_url: item.current,
    current_path: path.relative(root, item.currentPath),
    source_url: item.sourceUrl,
    source_path: path.relative(root, item.source),
    destination_path: path.relative(root, item.destination),
    status: "READY",
  }));
  await writeCsv(path.join(reportDir, "production-sync-plan.csv"), preflight);
  if (!apply) {
    console.log(JSON.stringify({ dry_run: true, target_count: plan.length, report: path.join(reportDir, "production-sync-plan.csv") }));
    return;
  }

  const startMs = Date.now();
  const manifestRows = [];
  const outputRows = [];
  for (const item of plan) {
    const currentHash = await sha256(item.currentPath);
    const archiveName = `${item.code}--${path.basename(item.currentPath)}`;
    const archivePath = path.join(archiveDir, archiveName);
    try {
      const archivedHash = await sha256(archivePath);
      if (archivedHash !== currentHash) throw new Error(`ARCHIVE_COLLISION:${item.code}`);
    } catch (error) {
      if (error.code === "ENOENT") await fs.copyFile(item.currentPath, archivePath);
      else throw error;
    }

    let operation = "copy";
    let cropInfo = { crop_left: "", width: "", height: "" };
    if (item.label.type === "right" || item.label.type === "center") {
      cropInfo = await crop(item.source, item.destination, item.label.type);
      operation = `${item.label.type}_crop`;
    } else {
      await copyIfNew(item.source, item.destination);
    }
    const outputStat = await fs.stat(item.destination);
    const outputMeta = await imageMetadata(item.destination);
    if (!outputStat.size || !outputMeta.width || !outputMeta.height) throw new Error(`OUTPUT_INVALID:${item.code}`);
    const afterHash = await sha256(item.destination);
    manifestRows.push({
      product_code: item.code,
      original_path: path.relative(root, item.currentPath),
      archive_path: path.relative(root, archivePath),
      before_sha256: currentHash,
      current_url: item.current,
    });
    outputRows.push({
      product_code: item.code,
      type: item.label.type,
      source_id: item.label.source,
      source_path: path.relative(root, item.source),
      destination_path: path.relative(root, item.destination),
      after_sha256: afterHash,
      width: outputMeta.width,
      height: outputMeta.height,
      bytes: outputStat.size,
      operation,
      crop_left: cropInfo.crop_left,
    });
  }

  const publicEntries = await fs.readdir(publicDir, { withFileTypes: true });
  const modified = [];
  for (const entry of publicEntries) {
    if (!entry.isFile()) continue;
    const file = path.join(publicDir, entry.name);
    const stat = await fs.stat(file);
    if (stat.mtimeMs >= startMs - 1) modified.push(path.relative(root, file));
  }
  const intended = new Set(plan.map((item) => path.relative(root, item.destination)));
  const outside = modified.filter((file) => !intended.has(file));
  if (outside.length) throw new Error(`OUTSIDE_PUBLIC_CHANGE:${outside.join(",")}`);
  if (new Set(modified).size !== plan.length) throw new Error(`PUBLIC_CHANGE_COUNT:${modified.length}`);

  await writeCsv(path.join(archiveDir, "manifest.csv"), manifestRows);
  await writeCsv(path.join(reportDir, "output-verification.csv"), outputRows);
  await writeCsv(path.join(reportDir, "public-modified-files.csv"), modified.map((file) => ({ path: file, in_target_plan: intended.has(file) })));
  await fs.writeFile(path.join(reportDir, "production-sync-summary.md"), [
    "# Targeted local gold thumbnail sync",
    "",
    `- Target codes: ${plan.length}`,
    `- Local public outputs: ${outputRows.length}`,
    `- Output images valid: ${outputRows.length}`,
    `- Outside public changes: ${outside.length}`,
    "- Network, DB, Git, Vercel, build, lint, and deployment: not used.",
  ].join("\n") + "\n");
  console.log(JSON.stringify({ target_count: plan.length, outputs: outputRows.length, outside_public_changes: outside.length, report: reportDir }));
}

await main();
