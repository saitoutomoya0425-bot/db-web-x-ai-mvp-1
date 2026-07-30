import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";

const root = process.cwd();
const outDir = path.join(root, "tmp", "card-thumbnail-v2-dry-run");
const cacheDir = path.join(outDir, "cache");
const reportPath = path.join(outDir, "report.json");
const representativeCodes = new Set([
  "H_1784FTO00064",
  "1SBP00417",
  "H_1784FTO00062",
  "1FCDSS00115",
  "AQUCO00184",
  "BEBL00057",
]);

const MIN_SAMPLE_SHORT_EDGE = 360;
const MIN_SAMPLE_AREA = 200_000;
const IDEAL_CARD_RATIO = 0.7;
const RIGHT_COVER_RATIO = 0.735;

await fs.mkdir(cacheDir, { recursive: true });

function normalizeUrl(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isLocalCard(url) {
  return typeof url === "string" && url.startsWith("/card-thumbnails/");
}

function isOfficialImage(url) {
  if (isLocalCard(url)) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "pics.dmm.co.jp";
  } catch {
    return false;
  }
}

function cachePathForUrl(url) {
  const parsed = isLocalCard(url) ? null : new URL(url);
  const ext = parsed ? path.extname(parsed.pathname) || ".jpg" : ".jpg";
  return path.join(cacheDir, `${createHash("sha1").update(url).digest("hex")}${ext}`);
}

async function imageBuffer(url) {
  if (!url || !isOfficialImage(url)) return null;
  if (isLocalCard(url)) {
    try {
      return await fs.readFile(path.join(root, "public", url.replace(/^\//, "")));
    } catch {
      return null;
    }
  }
  const file = cachePathForUrl(url);
  try {
    return await fs.readFile(file);
  } catch {
    // fetch below
  }
  try {
    const response = await fetch(url, {
      headers: { accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 0) await fs.writeFile(file, buffer);
    return buffer;
  } catch {
    return null;
  }
}

async function imageMetaFromBuffer(buffer) {
  if (!buffer) return null;
  try {
    const meta = await sharp(buffer).metadata();
    if (!meta.width || !meta.height) return null;
    return {
      width: meta.width,
      height: meta.height,
      ratio: meta.width / meta.height,
      area: meta.width * meta.height,
      shortEdge: Math.min(meta.width, meta.height),
    };
  } catch {
    return null;
  }
}

async function visualMetrics(buffer) {
  const { data, info } = await sharp(buffer)
    .resize(160, 220, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let edgeCount = 0;
  let topBottomEdgeCount = 0;
  let centerEdgeCount = 0;
  let count = 0;
  let topBottomCount = 0;
  let centerCount = 0;
  let saturationSum = 0;
  let skinLike = 0;
  let darkOrLight = 0;

  for (let y = 1; y < info.height - 1; y += 1) {
    for (let x = 1; x < info.width - 1; x += 1) {
      const i = (y * info.width + x) * info.channels;
      const right = (y * info.width + x + 1) * info.channels;
      const left = (y * info.width + x - 1) * info.channels;
      const up = ((y - 1) * info.width + x) * info.channels;
      const down = ((y + 1) * info.width + x) * info.channels;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const lumaRight = (data[right] + data[right + 1] + data[right + 2]) / 3;
      const lumaLeft = (data[left] + data[left + 1] + data[left + 2]) / 3;
      const lumaUp = (data[up] + data[up + 1] + data[up + 2]) / 3;
      const lumaDown = (data[down] + data[down + 1] + data[down + 2]) / 3;
      const edge = Math.abs(lumaRight - lumaLeft) + Math.abs(lumaDown - lumaUp);
      const isEdge = edge > 80;
      if (isEdge) edgeCount += 1;
      count += 1;

      const isTopBottom = y < info.height * 0.27 || y > info.height * 0.73;
      if (isTopBottom) {
        if (isEdge) topBottomEdgeCount += 1;
        topBottomCount += 1;
      } else {
        if (isEdge) centerEdgeCount += 1;
        centerCount += 1;
      }

      const maxChannel = Math.max(r, g, b);
      const minChannel = Math.min(r, g, b);
      saturationSum += maxChannel - minChannel;
      if (r > 95 && g > 45 && b > 25 && r > g * 1.05 && r > b * 1.18 && maxChannel - minChannel > 15) {
        skinLike += 1;
      }
      const luma = (r + g + b) / 3;
      if (luma < 25 || luma > 235) darkOrLight += 1;
    }
  }

  const seamScores = [];
  for (let x = 8; x < info.width - 8; x += 8) {
    let columnDiff = 0;
    for (let y = 0; y < info.height; y += 1) {
      const i = (y * info.width + x) * info.channels;
      const left = (y * info.width + x - 1) * info.channels;
      columnDiff += Math.abs(data[i] - data[left])
        + Math.abs(data[i + 1] - data[left + 1])
        + Math.abs(data[i + 2] - data[left + 2]);
    }
    seamScores.push(columnDiff / info.height);
  }
  seamScores.sort((a, b) => b - a);

  const edgeDensity = edgeCount / Math.max(count, 1);
  const topBottomEdgeDensity = topBottomEdgeCount / Math.max(topBottomCount, 1);
  const centerEdgeDensity = centerEdgeCount / Math.max(centerCount, 1);
  return {
    edgeDensity,
    topBottomEdgeDensity,
    centerEdgeDensity,
    topBottomLift: topBottomEdgeDensity / Math.max(centerEdgeDensity, 0.001),
    saturation: saturationSum / Math.max(count, 1),
    seamStrength: seamScores[0] ?? 0,
    skinRatio: skinLike / Math.max(count, 1),
    flatExtremeRatio: darkOrLight / Math.max(count, 1),
  };
}

function hasIdentitySignal(video) {
  const text = [video.title, video.series_name, video.genre, video.label_name].filter(Boolean).join(" ");
  return /(BEST|ベスト|総集編|デビュー|初撮り|周年|VR|4K|8K|MONSTER|モンスター|ハーレム|先生|内申点|天使|応援|ラウンジ|\d+\s*分|\d+\s*時間|\d+\s*作品|\d+\s*本番|\d+\s*タイトル|\d+\s*人|\d+\s*P|\d+\s*連発|VS|ＶＳ|大会|企画|新人NO\.?1|NO\.?1STYLE|ナンバーワンスタイル|ひ・と・き・わ|ドキュメント|Gonzo Document|特化|Complete|コンプリート)/i.test(text);
}

function isEnsembleOrCompilation(video) {
  const text = [video.title, video.series_name, video.genre, video.label_name].filter(Boolean).join(" ");
  return /(BEST|ベスト|総集編|オムニバス|大人数|共演|出演|女優.*人|人出演|祭|大会|\d+\s*人|\d+\s*作品|\d+\s*本番|\d+\s*時間|\d+\s*分)/i.test(text);
}

function classifyCurrent(url, thumbnailUrl, sampleImages) {
  if (!url) return "missing";
  if (url === thumbnailUrl) return "dvd_full";
  if (sampleImages.includes(url)) return "sample";
  if (isLocalCard(url) && /(?:auto-right|right-auto|right-final)/.test(url)) return "dvd_right";
  if (isLocalCard(url) && url.includes("rotated")) return "rotated";
  if (isLocalCard(url)) return "local_card";
  return "other";
}

function roundMetric(value) {
  return Number(value.toFixed(3));
}

function scoreCandidate({ candidate, video, meta, visual, lowResolution, rightContextLoss, rightUnsafe }) {
  const ratioDistance = Math.abs(meta.ratio - IDEAL_CARD_RATIO);
  const cardFit = Math.max(0, 22 - ratioDistance * 24);
  const posterShape = meta.ratio >= 0.56 && meta.ratio <= 0.88;
  const vertical = meta.height > meta.width;
  const informationDense =
    visual.topBottomEdgeDensity >= 0.15
    && visual.edgeDensity >= 0.13
    && visual.seamStrength >= 70
    && visual.skinRatio < 0.62;
  const jacketLike =
    posterShape
    && visual.topBottomEdgeDensity >= 0.1
    && visual.edgeDensity >= 0.1
    && visual.skinRatio < 0.58;
  const plainScene =
    visual.topBottomEdgeDensity < 0.09
    && visual.seamStrength < 80
    && visual.edgeDensity < 0.13;
  const bodyPartRisk =
    visual.skinRatio >= 0.5
    && visual.topBottomEdgeDensity < 0.12
    && visual.seamStrength < 90;

  let score = 0;
  const reasons = [];
  if (lowResolution) {
    return {
      score: -999,
      review: false,
      excluded: true,
      reasons: ["low_resolution_for_card"],
      flags: { informationDense, jacketLike, plainScene, bodyPartRisk, rightContextLoss, rightUnsafe },
    };
  }

  score += cardFit;
  if (vertical) score += 10;
  if (posterShape) score += 10;
  if (meta.shortEdge >= 450) score += 8;
  else if (meta.shortEdge >= 360) score += 4;
  if (hasIdentitySignal(video)) score += 8;
  if (isEnsembleOrCompilation(video)) score += 5;

  if (informationDense) {
    score += 28;
    reasons.push("information_dense_layout");
  }
  if (jacketLike) {
    score += 20;
    reasons.push("jacket_like_layout");
  }
  if (visual.topBottomLift >= 1.25) score += 8;
  if (visual.seamStrength >= 120) score += 10;
  else if (visual.seamStrength >= 90) score += 5;
  if (visual.saturation >= 45) score += 3;

  if (candidate.type === "sample") {
    score += 2;
    if (!informationDense && !jacketLike) {
      score -= 28;
      reasons.push("sample_not_representative");
    }
  }
  if (candidate.type === "dvd_right") {
    score += 3;
    if (rightContextLoss) {
      score -= 30;
      reasons.push("right_crop_loses_context");
    }
    if (rightUnsafe || bodyPartRisk) {
      score -= 34;
      reasons.push("right_crop_body_part_or_closeup_risk");
    }
  }
  if (candidate.type === "dvd_full") {
    score -= 8;
    if (rightContextLoss) {
      score += 24;
      reasons.push("dvd_full_preserves_context");
    }
    if (informationDense) score += 8;
  }
  if (candidate.type === "vertical_package") {
    score += 8;
    if (!jacketLike && !informationDense) score -= 6;
  }

  if (plainScene) {
    score -= 24;
    reasons.push("plain_scene_like");
  }
  if (bodyPartRisk && candidate.type !== "dvd_full") {
    score -= 26;
    reasons.push("body_part_or_closeup_risk");
  }
  if (visual.flatExtremeRatio > 0.34) score -= 4;

  return {
    score: Math.round(score),
    review: score < 48 || (candidate.type === "sample" && !informationDense && !jacketLike),
    excluded: false,
    reasons,
    flags: { informationDense, jacketLike, plainScene, bodyPartRisk, rightContextLoss, rightUnsafe },
  };
}

async function makeRightCandidateBuffer(thumbnailBuffer) {
  const meta = await imageMetaFromBuffer(thumbnailBuffer);
  if (!meta || meta.ratio < 1.2) return null;
  const cropWidth = Math.max(1, Math.min(meta.width, Math.round(meta.height * RIGHT_COVER_RATIO)));
  const left = Math.max(0, meta.width - cropWidth);
  const buffer = await sharp(thumbnailBuffer)
    .extract({ left, top: 0, width: Math.min(cropWidth, meta.width - left), height: meta.height })
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer();
  return { buffer, left, cropWidth };
}

async function analyzeCandidate(candidate, video, context = {}) {
  const buffer = candidate.buffer ?? await imageBuffer(candidate.url);
  const meta = await imageMetaFromBuffer(buffer);
  if (!buffer || !meta) return null;
  const visual = await visualMetrics(buffer);
  const lowResolution =
    candidate.type === "sample"
    && (meta.shortEdge < MIN_SAMPLE_SHORT_EDGE || meta.area < MIN_SAMPLE_AREA);
  const scored = scoreCandidate({
    candidate,
    video,
    meta,
    visual,
    lowResolution,
    rightContextLoss: Boolean(context.rightContextLoss),
    rightUnsafe: Boolean(context.rightUnsafe),
  });
  return {
    ...candidate,
    url: candidate.url,
    meta: {
      width: meta.width,
      height: meta.height,
      ratio: roundMetric(meta.ratio),
      area: meta.area,
      shortEdge: meta.shortEdge,
    },
    visual: Object.fromEntries(Object.entries(visual).map(([key, value]) => [key, roundMetric(value)])),
    ...scored,
  };
}

async function decide(video) {
  const sampleImages = Array.isArray(video.sample_images)
    ? video.sample_images.map(normalizeUrl).filter((url) => url && isOfficialImage(url))
    : [];
  const candidates = [];
  const thumbUrl = normalizeUrl(video.thumbnail_url);
  const currentUrl = normalizeUrl(video.card_thumbnail_url);
  const thumbBuffer = thumbUrl ? await imageBuffer(thumbUrl) : null;
  const thumbMeta = await imageMetaFromBuffer(thumbBuffer);
  const fullAnalysis = thumbUrl && thumbBuffer
    ? await analyzeCandidate({ type: "dvd_full", url: thumbUrl, buffer: thumbBuffer }, video)
    : null;
  const right = thumbBuffer ? await makeRightCandidateBuffer(thumbBuffer) : null;
  const rightBase = right
    ? await analyzeCandidate({ type: "dvd_right", url: "__generated_dvd_right__", buffer: right.buffer }, video)
    : null;
  let rightContextLoss = false;
  let rightUnsafe = false;
  if (rightBase && fullAnalysis) {
    rightContextLoss =
      hasIdentitySignal(video)
      && fullAnalysis.score - rightBase.score >= 12
      && fullAnalysis.visual.edgeDensity >= rightBase.visual.edgeDensity
      && fullAnalysis.visual.seamStrength >= rightBase.visual.seamStrength - 8;
    rightUnsafe =
      rightBase.visual.skinRatio >= 0.5
      && rightBase.visual.topBottomEdgeDensity < 0.12
      && rightBase.visual.seamStrength < 95;
  }
  if (fullAnalysis) candidates.push(fullAnalysis);
  if (right) {
    const rightCandidate = await analyzeCandidate({
      type: "dvd_right",
      url: `generated:${video.product_code}-auto-right.jpg`,
      buffer: right.buffer,
      cropLeft: right.left,
      cropWidth: right.cropWidth,
    }, video, { rightContextLoss, rightUnsafe });
    if (rightCandidate) candidates.push(rightCandidate);
  }
  if (thumbUrl && thumbMeta && thumbMeta.height > thumbMeta.width && thumbMeta.ratio >= 0.55 && thumbMeta.ratio <= 0.9) {
    const vertical = await analyzeCandidate({ type: "vertical_package", url: thumbUrl, buffer: thumbBuffer }, video);
    if (vertical) candidates.push(vertical);
  }
  for (const [index, url] of sampleImages.entries()) {
    const sample = await analyzeCandidate({ type: "sample", url, sampleIndex: index + 1 }, video);
    if (sample) candidates.push(sample);
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0] ?? null;
  const runnerUp = candidates[1] ?? null;
  const currentType = classifyCurrent(currentUrl, thumbUrl, sampleImages);
  const currentCandidate = currentType === "dvd_right"
    ? candidates.find((item) => item.type === "dvd_right")
    : candidates.find((item) => item.url === currentUrl)
      ?? (currentType === "dvd_full" ? candidates.find((item) => item.type === "dvd_full") : null);
  const ambiguous = best && runnerUp && best.score - runnerUp.score < 7;
  const needsReview = !best || best.review || ambiguous;
  const nextType = needsReview ? "needs_review" : best.type;
  const nextUrl = needsReview ? currentUrl : (best.type === "dvd_right"
    ? `/card-thumbnails/${video.product_code}-auto-right.jpg`
    : best.url);
  const changed = Boolean(!needsReview && currentUrl !== nextUrl);
  return {
    product_code: video.product_code,
    title: video.title,
    current_url: currentUrl,
    current_type: currentType,
    current_score: currentCandidate?.score ?? null,
    next_url: nextUrl,
    next_type: nextType,
    next_score: best?.score ?? null,
    changed,
    needs_review: needsReview,
    reason: needsReview
      ? (ambiguous ? "score_gap_too_small" : "best_candidate_below_auto_threshold")
      : best.reasons.join(",") || "highest_total_score",
    low_resolution_excluded: candidates.filter((item) => item.excluded).length,
    right_unsuitable: candidates.some((item) => item.type === "dvd_right" && item.flags?.rightUnsafe),
    right_context_loss: candidates.some((item) => item.type === "dvd_right" && item.flags?.rightContextLoss),
    candidates: candidates.slice(0, 8).map((item) => ({
      type: item.type,
      url: item.url,
      sampleIndex: item.sampleIndex ?? null,
      score: item.score,
      excluded: item.excluded,
      review: item.review,
      reasons: item.reasons,
      meta: item.meta,
      visual: item.visual,
      flags: item.flags,
    })),
  };
}

function tally(rows) {
  const byNextType = {};
  const byCurrentType = {};
  for (const row of rows) {
    byNextType[row.next_type] = (byNextType[row.next_type] ?? 0) + 1;
    byCurrentType[row.current_type] = (byCurrentType[row.current_type] ?? 0) + 1;
  }
  return {
    total: rows.length,
    changed: rows.filter((row) => row.changed).length,
    unchanged: rows.filter((row) => !row.changed && !row.needs_review).length,
    needs_review: rows.filter((row) => row.needs_review).length,
    low_resolution_excluded: rows.filter((row) => row.low_resolution_excluded > 0).length,
    right_unsuitable: rows.filter((row) => row.right_unsuitable).length,
    right_context_loss: rows.filter((row) => row.right_context_loss).length,
    by_next_type: byNextType,
    by_current_type: byCurrentType,
  };
}

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) throw new Error("Supabase environment variables are required");
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data, error } = await supabase
    .from("videos")
    .select("product_code,title,maker_name,series_name,label_name,genre,thumbnail_url,card_thumbnail_url,sample_images,is_published,created_at")
    .eq("is_published", true)
    .order("created_at", { ascending: true })
    .limit(2_000);
  if (error) throw error;

  const addedReportPath = path.join(root, "tmp", "publish-1000", "published-codes.json");
  const addedCodes = new Set(JSON.parse(await fs.readFile(addedReportPath, "utf8")).codes ?? []);
  const existingRows = [];
  const addedRows = [];
  const representativeRows = {};
  let processed = 0;
  for (const video of data ?? []) {
    const row = await decide(video);
    if (addedCodes.has(video.product_code)) addedRows.push(row);
    else existingRows.push(row);
    if (representativeCodes.has(video.product_code)) representativeRows[video.product_code] = row;
    processed += 1;
    if (processed % 100 === 0) console.log(JSON.stringify({ processed }));
  }

  const report = {
    generated_at: new Date().toISOString(),
    thresholds: {
      min_sample_short_edge: MIN_SAMPLE_SHORT_EDGE,
      min_sample_area: MIN_SAMPLE_AREA,
      ideal_card_ratio: IDEAL_CARD_RATIO,
      right_cover_ratio: RIGHT_COVER_RATIO,
    },
    existing300: {
      summary: tally(existingRows),
      rows: existingRows,
    },
    added700: {
      summary: tally(addedRows),
      rows: addedRows,
    },
    representatives: representativeRows,
  };
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));

  const compact = {
    report: reportPath,
    thresholds: report.thresholds,
    existing300: report.existing300.summary,
    added700: report.added700.summary,
    representatives: Object.fromEntries(Object.entries(representativeRows).map(([code, row]) => [
      code,
      {
        current_type: row.current_type,
        current_score: row.current_score,
        next_type: row.next_type,
        next_score: row.next_score,
        changed: row.changed,
        needs_review: row.needs_review,
        reason: row.reason,
        top_candidates: row.candidates.slice(0, 4).map((item) => ({
          type: item.type,
          score: item.score,
          file: item.url?.startsWith("http") ? path.basename(new URL(item.url).pathname) : item.url,
          reasons: item.reasons,
          flags: item.flags,
        })),
      },
    ])),
  };
  console.log(JSON.stringify(compact, null, 2));
}

await main();
