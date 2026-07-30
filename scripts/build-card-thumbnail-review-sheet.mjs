import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = process.cwd();
const sourceReportPath = path.join(root, "tmp", "card-thumbnail-v3-dry-run", "report.json");
const outDir = path.join(root, "tmp", "card-thumbnail-v3-review");
const assetDir = path.join(outDir, "assets");
const sheetDir = path.join(outDir, "sheets");
const cacheDir = path.join(root, "tmp", "card-thumbnail-v3-dry-run", "cache");
const htmlPath = path.join(outDir, "contact-sheet.html");
const jsonPath = path.join(outDir, "review-results.json");
const csvPath = path.join(outDir, "review-results.csv");

await fs.mkdir(assetDir, { recursive: true });
await fs.mkdir(sheetDir, { recursive: true });
await fs.mkdir(cacheDir, { recursive: true });

const report = JSON.parse(await fs.readFile(sourceReportPath, "utf8"));
const rows = report.added700.rows;
const highRows = rows.filter((row) => row.changed && row.confidence === "high");
const centerRows = rows.filter((row) => row.changed && row.next_type === "dvd_center");
const representativeCodes = new Set([
  "H_1784FTO00064",
  "1SBP00417",
  "H_1784FTO00062",
  "1FCDSS00115",
  "AQUCO00184",
  "BEBL00057",
]);

function hash(value) {
  return createHash("sha1").update(value).digest("hex");
}

function isLocalCard(url) {
  return typeof url === "string" && url.startsWith("/card-thumbnails/");
}

function isGenerated(url) {
  return typeof url === "string" && url.startsWith("generated:");
}

function fileNameOf(url) {
  if (!url) return "";
  if (isGenerated(url) || isLocalCard(url)) return url;
  try {
    return path.basename(new URL(url).pathname);
  } catch {
    return url;
  }
}

function cachePathForUrl(url) {
  const parsed = new URL(url);
  const ext = path.extname(parsed.pathname) || ".jpg";
  return path.join(cacheDir, `${hash(url)}${ext}`);
}

async function imageBufferFromOfficialUrl(url) {
  const cached = cachePathForUrl(url);
  try {
    return await fs.readFile(cached);
  } catch {
    // fetch below
  }
  const response = await fetch(url, {
    headers: { accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`failed to fetch ${url}: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(cached, buffer);
  return buffer;
}

async function candidateBuffer(row, candidate) {
  if (!candidate?.url) return null;
  if (isGenerated(candidate.url)) {
    const full = row.candidates.find((item) => item.type === "dvd_full");
    if (!full?.url || isGenerated(full.url)) return null;
    const source = await candidateBuffer(row, full);
    if (!source || candidate.cropLeft === null || candidate.cropWidth === null) return null;
    const meta = await sharp(source).metadata();
    if (!meta.width || !meta.height) return null;
    return sharp(source)
      .extract({
        left: Math.max(0, Number(candidate.cropLeft)),
        top: 0,
        width: Math.min(Number(candidate.cropWidth), meta.width - Number(candidate.cropLeft)),
        height: meta.height,
      })
      .jpeg({ quality: 92, mozjpeg: true })
      .toBuffer();
  }
  if (isLocalCard(candidate.url)) {
    try {
      return await fs.readFile(path.join(root, "public", candidate.url.replace(/^\//, "")));
    } catch {
      return null;
    }
  }
  try {
    const parsed = new URL(candidate.url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "pics.dmm.co.jp") return null;
    return await imageBufferFromOfficialUrl(candidate.url);
  } catch {
    return null;
  }
}

function pickCandidates(row) {
  const byType = (type) => row.candidates.find((item) => item.type === type && !item.excluded);
  const current = row.current_type === "dvd_right"
    ? byType("dvd_right")
    : row.current_type === "dvd_center"
      ? byType("dvd_center")
      : row.candidates.find((item) => item.url === row.current_url)
        ?? (row.current_type === "dvd_full" ? byType("dvd_full") : null);
  const next = row.candidates.find((item) => item.type === row.next_type && item.url === row.next_url)
    ?? (row.next_type === "dvd_right" ? byType("dvd_right") : null)
    ?? (row.next_type === "dvd_center" ? byType("dvd_center") : null)
    ?? row.candidates[0];
  const sample = row.candidates.find((item) => item.type === "sample" && !item.excluded && item.score >= 58)
    ?? row.candidates.find((item) => item.type === "sample" && !item.excluded);
  return [
    ["現在", current],
    ["新候補", next],
    ["DVD全面", byType("dvd_full")],
    ["DVD右側", byType("dvd_right")],
    ["中央", byType("dvd_center")],
    ["sample", sample],
    ["縦長", byType("vertical_package")],
  ];
}

async function renderAsset(row, label, candidate) {
  if (!candidate) return null;
  const buffer = await candidateBuffer(row, candidate);
  if (!buffer) return null;
  const filename = `${row.product_code}-${label}-${hash(candidate.url).slice(0, 8)}.jpg`.replace(/[^A-Za-z0-9_.-]/g, "_");
  const file = path.join(assetDir, filename);
  await sharp(buffer)
    .resize(180, 250, { fit: "contain", background: "#f5f5f7" })
    .jpeg({ quality: 88, mozjpeg: true })
    .toFile(file);
  return {
    label,
    file,
    rel: path.relative(outDir, file),
    source: candidate.url,
    source_file: fileNameOf(candidate.url),
    type: candidate.type,
    score: candidate.score,
    reasons: candidate.reasons ?? [],
    components: candidate.components ?? null,
    flags: candidate.flags ?? {},
    meta: candidate.meta ?? null,
  };
}

function hasRisk(candidate) {
  return Boolean(
    candidate?.flags?.bodyPartOrClose
    || candidate?.flags?.faceOnlyLike
    || candidate?.flags?.plainScene
    || candidate?.components?.bodyPart > 0
    || candidate?.components?.faceOnly > 0
    || candidate?.components?.scenePhoto >= 40
    || candidate?.reasons?.some((reason) => /body_part|face_only|plain_scene|person_or_text_cut/.test(reason)),
  );
}

function classify(row) {
  const best = row.candidates.find((item) => item.type === row.next_type) ?? row.candidates[0];
  const full = row.candidates.find((item) => item.type === "dvd_full");
  const right = row.candidates.find((item) => item.type === "dvd_right");
  const center = row.candidates.find((item) => item.type === "dvd_center");
  const delta = row.score_delta ?? ((row.next_score ?? 0) - (row.current_score ?? 0));
  const topGap = row.candidates[1] ? (row.candidates[0].score - row.candidates[1].score) : 999;
  const centerStrict =
    row.next_type !== "dvd_center"
    || (
      center
      && !hasRisk(center)
      && center.score >= 115
      && delta >= 50
      && (right ? center.score - right.score >= 18 : true)
      && (full ? center.score - full.score >= 18 : true)
      && (
        center.reasons?.includes("center_crop_rescues_side_band")
        || right?.flags?.cropLooksCut
        || right?.flags?.bodyPartOrClose
        || (right && right.score < 45)
      )
    );
  if (!best || hasRisk(best) || row.next_score < 78 || delta < 24) {
    return {
      class: "C",
      label: "反映禁止・needs_reviewへ戻す",
      reason: "候補リスクあり、または改善差/スコア不足",
    };
  }
  if (!centerStrict) {
    return {
      class: "B",
      label: "目視承認後なら反映可能",
      reason: "中央切り抜きが勝つが、右側/全面との差や救済条件がまだ弱い",
    };
  }
  if (topGap < 12) {
    return {
      class: "B",
      label: "目視承認後なら反映可能",
      reason: "候補間が僅差",
    };
  }
  if (row.next_type === "dvd_full" && full && right && full.score - right.score < 24) {
    return {
      class: "B",
      label: "目視承認後なら反映可能",
      reason: "DVD全面と右側切り抜きの判断に主観差あり",
    };
  }
  return {
    class: "A",
    label: "自動反映可能",
    reason: "現在画像より明確に改善し、リスク指標なし",
  };
}

const highDetails = [];
for (const row of highRows) {
  const candidates = [];
  for (const [label, candidate] of pickCandidates(row)) {
    candidates.push(await renderAsset(row, label, candidate));
  }
  const classification = classify(row);
  highDetails.push({
    product_code: row.product_code,
    title: row.title,
    current_type: row.current_type,
    next_type: row.next_type,
    current_score: row.current_score,
    next_score: row.next_score,
    score_delta: row.score_delta,
    confidence: row.confidence,
    classification,
    candidates,
  });
}

function detailForCode(code) {
  const row = rows.find((item) => item.product_code === code);
  if (!row) return null;
  const best = row.candidates[0];
  const classification = row.changed && row.confidence === "high" ? classify(row) : {
    class: row.needs_review ? "C" : "B",
    label: row.needs_review ? "反映禁止・needs_reviewへ戻す" : "目視承認後なら反映可能",
    reason: row.reason,
  };
  return {
    product_code: row.product_code,
    current_type: row.current_type,
    next_type: row.next_type,
    current_score: row.current_score,
    next_score: row.next_score,
    changed: row.changed,
    needs_review: row.needs_review,
    confidence: row.confidence,
    classification,
    recommended_type: classification.class === "A" ? row.next_type : (row.needs_review ? "needs_review" : best?.type),
    recommended_reason: classification.reason,
    top_candidates: row.candidates.slice(0, 6).map((item) => ({
      type: item.type,
      file: fileNameOf(item.url),
      score: item.score,
      reasons: item.reasons,
      flags: item.flags,
      components: item.components,
    })),
  };
}

const representativeDetails = Object.fromEntries([...representativeCodes].map((code) => [code, detailForCode(code)]));
const classCounts = highDetails.reduce((acc, item) => {
  acc[item.classification.class] = (acc[item.classification.class] ?? 0) + 1;
  return acc;
}, {});
const classCodes = {
  A: highDetails.filter((item) => item.classification.class === "A").map((item) => item.product_code),
  B: highDetails.filter((item) => item.classification.class === "B").map((item) => item.product_code),
  C: highDetails.filter((item) => item.classification.class === "C").map((item) => item.product_code),
};
const centerDetails = centerRows.map((row) => ({
  product_code: row.product_code,
  confidence: row.confidence,
  next_score: row.next_score,
  current_score: row.current_score,
  score_delta: row.score_delta,
  classification: highDetails.find((item) => item.product_code === row.product_code)?.classification ?? {
    class: "B",
    label: "目視承認後なら反映可能",
    reason: "high以外の中央切り抜き候補",
  },
}));
const centerCounts = centerDetails.reduce((acc, item) => {
  acc[item.classification.class] = (acc[item.classification.class] ?? 0) + 1;
  return acc;
}, {});

const review = {
  generated_at: new Date().toISOString(),
  source_report: sourceReportPath,
  policy: {
    existing300: "完全固定。比較資料も追加700件のみ。",
    no_db_update: true,
    no_public_image_write: true,
    no_deploy: true,
  },
  counts: {
    high_total: highDetails.length,
    center_candidate_total: centerRows.length,
    auto_reflectable_A: classCounts.A ?? 0,
    visual_approval_B: classCounts.B ?? 0,
    reject_C: classCounts.C ?? 0,
    center_recheck: centerCounts,
  },
  codes: classCodes,
  final_first_pass_candidates: classCodes.A,
  representatives: representativeDetails,
  high_details: highDetails.map((item) => ({
    ...item,
    candidates: item.candidates.map((candidate) => candidate ? {
      ...candidate,
      file: candidate.rel,
    } : null),
  })),
  center_details: centerDetails,
};
await fs.writeFile(jsonPath, JSON.stringify(review, null, 2));

const csvColumns = [
  "product_code",
  "title",
  "current_type",
  "next_type",
  "current_score",
  "next_score",
  "score_delta",
  "confidence",
  "classification",
  "classification_reason",
];
const csv = [
  csvColumns.join(","),
  ...highDetails.map((item) => csvColumns.map((column) => JSON.stringify(
    column === "classification" ? item.classification.class
      : column === "classification_reason" ? item.classification.reason
        : item[column] ?? "",
  )).join(",")),
].join("\n");
await fs.writeFile(csvPath, csv);

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const htmlRows = highDetails.map((item) => `
  <section class="work class-${item.classification.class}">
    <header>
      <h2>${htmlEscape(item.product_code)}</h2>
      <p>${htmlEscape(item.title)}</p>
      <p class="meta">${htmlEscape(item.current_type)} ${item.current_score ?? "—"} → ${htmlEscape(item.next_type)} ${item.next_score ?? "—"} / Δ${item.score_delta ?? "—"} / ${item.confidence} / ${item.classification.class}: ${htmlEscape(item.classification.reason)}</p>
    </header>
    <div class="grid">
      ${item.candidates.map((candidate) => candidate ? `
        <figure>
          <img src="${htmlEscape(candidate.rel)}" alt="${htmlEscape(item.product_code)} ${htmlEscape(candidate.label)}">
          <figcaption>${htmlEscape(candidate.label)}<br>${htmlEscape(candidate.type)} / ${candidate.score ?? "—"}<br><span>${htmlEscape(candidate.source_file)}</span></figcaption>
        </figure>
      ` : `
        <figure class="empty"><div>なし</div><figcaption>候補なし</figcaption></figure>
      `).join("")}
    </div>
  </section>
`).join("\n");

await fs.writeFile(htmlPath, `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>card thumbnail v3 review</title>
<style>
body{margin:0;background:#f5f5f7;color:#1d1d1f;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:1440px;margin:0 auto;padding:28px}
h1{font-size:28px;margin:0 0 8px}
.summary{font-size:14px;color:#555;margin-bottom:20px}
.work{break-inside:avoid;margin:0 0 20px;padding:16px;border:1px solid #ddd;border-radius:18px;background:white;box-shadow:0 8px 24px rgba(0,0,0,.05)}
.work header{margin-bottom:12px}
.work h2{margin:0;font-size:20px}
.work p{margin:4px 0;color:#555}
.meta{font-size:13px}
.class-A{border-color:#5ac878}.class-B{border-color:#f2c94c}.class-C{border-color:#ff7b72}
.grid{display:grid;grid-template-columns:repeat(7,minmax(120px,1fr));gap:12px}
figure{margin:0;padding:8px;border-radius:14px;background:#f5f5f7;text-align:center}
figure img{width:100%;height:250px;object-fit:contain;border-radius:10px;background:#eee}
figure.empty{display:grid;place-items:center;min-height:310px;color:#aaa}
figcaption{font-size:12px;line-height:1.45;color:#333;margin-top:6px}
figcaption span{font-size:10px;color:#777;word-break:break-all}
@media print{main{max-width:none}.work{page-break-inside:avoid;box-shadow:none}}
</style>
</head>
<body><main>
<h1>card thumbnail v3 review</h1>
<p class="summary">high ${highDetails.length}件 / A ${classCounts.A ?? 0}件 / B ${classCounts.B ?? 0}件 / C ${classCounts.C ?? 0}件。DB更新・画像反映なし。</p>
${htmlRows}
</main></body></html>`);

async function makeSheet(items, filename, title) {
  const cellW = 170;
  const cellH = 270;
  const cols = 7;
  const headerH = 76;
  const rowH = cellH + 92;
  const width = cols * cellW + 80;
  const height = headerH + items.length * rowH + 30;
  const composites = [{
    input: Buffer.from(`<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="#f5f5f7"/><text x="28" y="38" font-family="Arial" font-size="24" font-weight="700" fill="#1d1d1f">${htmlEscape(title)}</text></svg>`),
    top: 0,
    left: 0,
  }];
  for (const [rowIndex, item] of items.entries()) {
    const y = headerH + rowIndex * rowH;
    composites.push({
      input: Buffer.from(`<svg width="${width}" height="${rowH}">
        <rect x="16" y="0" width="${width - 32}" height="${rowH - 12}" rx="18" fill="#fff" stroke="#ddd"/>
        <text x="28" y="24" font-family="Arial" font-size="16" font-weight="700" fill="#111">${htmlEscape(item.product_code)}</text>
        <text x="28" y="46" font-family="Arial" font-size="12" fill="#555">${htmlEscape(item.current_type)} ${item.current_score ?? "—"} → ${htmlEscape(item.next_type)} ${item.next_score ?? "—"} / ${item.classification.class}</text>
      </svg>`),
      top: y,
      left: 0,
    });
    for (const [colIndex, candidate] of item.candidates.entries()) {
      const x = 28 + colIndex * cellW;
      const imageY = y + 58;
      if (candidate?.file) {
        composites.push({
          input: await fs.readFile(candidate.file),
          top: imageY,
          left: x,
        });
      }
      composites.push({
        input: Buffer.from(`<svg width="${cellW - 14}" height="60">
          <text x="0" y="14" font-family="Arial" font-size="11" fill="#333">${htmlEscape(candidate?.label ?? "なし")} ${htmlEscape(candidate?.type ?? "")}</text>
          <text x="0" y="30" font-family="Arial" font-size="11" fill="#555">score ${candidate?.score ?? "—"}</text>
        </svg>`),
        top: imageY + 254,
        left: x,
      });
    }
  }
  const file = path.join(sheetDir, filename);
  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: "#f5f5f7",
    },
  }).composite(composites).png().toFile(file);
  return file;
}

const sheetFiles = [];
for (let i = 0; i < highDetails.length; i += 15) {
  sheetFiles.push(await makeSheet(highDetails.slice(i, i + 15), `high-${String(i / 15 + 1).padStart(2, "0")}.png`, `High review ${i + 1}-${Math.min(i + 15, highDetails.length)}`));
}
const representativeItems = highDetails.filter((item) => representativeCodes.has(item.product_code));
const extraRepresentativeRows = [...representativeCodes]
  .filter((code) => !representativeItems.some((item) => item.product_code === code))
  .map((code) => rows.find((row) => row.product_code === code))
  .filter(Boolean);
for (const row of extraRepresentativeRows) {
  const candidates = [];
  for (const [label, candidate] of pickCandidates(row)) {
    candidates.push(await renderAsset(row, label, candidate));
  }
  representativeItems.push({
    product_code: row.product_code,
    title: row.title,
    current_type: row.current_type,
    next_type: row.next_type,
    current_score: row.current_score,
    next_score: row.next_score,
    score_delta: row.score_delta,
    confidence: row.confidence,
    classification: detailForRep(row),
    candidates,
  });
}
function detailForRep(row) {
  if (row.needs_review) return { class: "C", label: "反映禁止・needs_reviewへ戻す", reason: row.reason };
  if (!row.changed) return { class: "B", label: "目視承認後なら反映可能", reason: "現状維持または判断継続" };
  return classify(row);
}
sheetFiles.push(await makeSheet(representativeItems, "representatives.png", "Representative 6"));

const sheetList = sheetFiles.map((file) => path.relative(root, file));
console.log(JSON.stringify({
  html: path.relative(root, htmlPath),
  json: path.relative(root, jsonPath),
  csv: path.relative(root, csvPath),
  sheets: sheetList,
  counts: review.counts,
}, null, 2));
