import fs from "node:fs/promises";
import path from "node:path";

const CSV_PATH = path.join("data", "thumbnail-gold-labels.csv");

function parseCsv(text) {
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
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      pushField();
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      pushRow();
    } else {
      field += char;
    }
  }
  pushRow();

  const [header = [], ...rows] = records;
  return rows
    .filter((values) => values.some((value) => value.trim()))
    .map((values) => Object.fromEntries(header.map((name, index) => [name.replace(/^\uFEFF/, ""), values[index] ?? ""])));
}

export async function loadThumbnailGoldLabels(root = process.cwd()) {
  const raw = await fs.readFile(path.join(root, CSV_PATH), "utf8");
  const labels = parseCsv(raw);
  const seen = new Set();
  const byCode = new Map();
  for (const label of labels) {
    const code = String(label.product_code ?? "").trim();
    if (!code) throw new Error("GOLD_LABEL_MISSING_PRODUCT_CODE");
    if (seen.has(code)) throw new Error(`GOLD_LABEL_DUPLICATE:${code}`);
    seen.add(code);
    byCode.set(code, {
      productCode: code,
      type: String(label.expected_type ?? "").trim(),
      source: String(label.expected_source ?? "").trim(),
      status: String(label.decision_status ?? "").trim(),
    });
  }
  return byCode;
}

function sampleIndexFromSource(source) {
  const matched = /^sample:(\d+)(?:_|$)/.exec(source);
  return matched ? Number(matched[1]) : null;
}

function canonicalToDisplay(type) {
  return {
    right: "右側表紙",
    center: "中央切り抜き",
    full: "DVD全面",
    sample: "サンプル",
    scene_portrait: "scene portrait",
    keep_current: "既存維持",
  }[type] ?? type;
}

/**
 * Resolves a reviewed gold label to one exact candidate.  It deliberately
 * fails closed: an absent sample number or generated crop is never replaced
 * with a lookalike candidate.
 */
export function resolveGoldThumbnail({ label, currentUrl, fullUrl, rightUrl, centerUrl, samples }) {
  if (!label) return null;
  const source = label.source;
  let url = null;

  if (label.type === "keep_current" || label.type === "scene_portrait") {
    url = currentUrl;
  } else if (label.type === "full" && source === "dvd:full") {
    url = fullUrl;
  } else if (label.type === "right" && source === "dvd:right") {
    url = rightUrl;
  } else if (label.type === "center" && source === "dvd:center") {
    url = centerUrl;
  } else if (label.type === "sample") {
    const sampleIndex = sampleIndexFromSource(source);
    if (sampleIndex !== null) url = samples[sampleIndex - 1] ?? null;
  }

  if (!url) {
    return {
      blocked: true,
      code: "GOLD_SOURCE_UNAVAILABLE",
      message: `${label.productCode}:${label.type}:${source}`,
    };
  }
  return {
    blocked: false,
    url,
    canonicalType: label.type,
    source,
    type: canonicalToDisplay(label.type),
    reason: `gold label fixed candidate (${label.type}/${source})`,
  };
}

export function assertGoldAcceptance(results, labels) {
  const mismatches = [];
  for (const label of labels.values()) {
    const result = results.get(label.productCode);
    if (!result) {
      mismatches.push({ product_code: label.productCode, actual_type: "missing", actual_source: "", expected_type: label.type, expected_source: label.source, reason: "missing_result" });
      continue;
    }
    if (result.blocked || result.canonicalType !== label.type || result.source !== label.source) {
      mismatches.push({ product_code: label.productCode, actual_type: result.canonicalType ?? "", actual_source: result.source ?? "", expected_type: label.type, expected_source: label.source, reason: result.blocked ? result.code : "type_or_source_mismatch" });
    }
  }
  if (mismatches.length) {
    const error = new Error(`GOLD_LABEL_REGRESSION:${mismatches.length}`);
    error.mismatches = mismatches;
    throw error;
  }
}
