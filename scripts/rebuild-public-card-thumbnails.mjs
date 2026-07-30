import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import postgres from "postgres";
import sharp from "sharp";
import { assertGoldAcceptance, loadThumbnailGoldLabels, resolveGoldThumbnail } from "./lib/thumbnail-gold-acceptance.mjs";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const outDir = path.join(root, "public", "card-thumbnails");
const workDir = path.join(root, "tmp", "card-rebuild");
const downloadDir = path.join(workDir, "downloads");
const reportPath = path.join(workDir, "report.json");
const dryRun = process.argv.includes("--dry-run");
const max = Number(process.argv.find((arg) => arg.startsWith("--max="))?.split("=")[1] ?? "0");
const targetCodes = new Set(
  (process.argv.find((arg) => arg.startsWith("--codes="))?.split("=")[1] ?? "")
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean),
);
const SAMPLE_ACCEPT_SCORE = 70;
const SAME_DESIGN_DISTANCE = 44;
const RIGHT_COVER_CARD_RATIO = 0.735;
const GOLD_LABELS = await loadThumbnailGoldLabels(root);

const FORCE_SAMPLE_FIRST = new Set([
  "VRKM01846",
  "VRKM01868",
  "1NHVR00226",
  "NKWMR00026",
  "1SGKI00093B",
  "1TLDC00056",
  "1SEVEN00036",
  "SNOS00370",
  "SNOS00263",
  "DSUVR00003",
  "SAVR01109",
  "SAVR01117",
  "VRKM01831",
  "VRKM01833",
  "VRKM01857",
  "VRKM01862",
  "VRPRD00198",
  "VRKM01869",
  "VRKM01852",
  "UMSO00649",
  "SNOS-183",
  "SNOS-209",
]);

const FORCE_SAMPLE_URL = new Map([
  [
    "DSUVR00003",
    "https://pics.dmm.co.jp/digital/video/dsuvr00003/dsuvr00003jp-2.jpg",
  ],
]);

const FORCE_RIGHT_COVER = new Set([
  "RBB00339",
  "SNOS00312",
  "CJOD00534",
  "H_113PS00131",
  "YMDS00298",
]);

const FORCE_DVD_FULL_CONTEXT = new Set([
  "YMDS00300",
  "YMDS00301",
]);

const PRESERVE_ROTATED = new Set(["1SBP00426", "1SBP00427", "1SBP00428"]);

function safeCode(code) {
  return String(code).replace(/[^A-Za-z0-9_-]/g, "_");
}

function isOfficialImage(url) {
  if (typeof url !== "string" || !url.trim()) return false;
  if (url.startsWith("/card-thumbnails/")) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "pics.dmm.co.jp";
  } catch {
    return false;
  }
}

function hasStrongIdentityText(video) {
  const text = [
    video.title,
    video.series_name,
  ].filter(Boolean).join(" ");
  return /(BEST|ベスト|総集編|デビュー|初撮り|周年|VR|4K|8K|MONSTER|モンスター|ハーレム|先生|内申点|天使|応援|ラウンジ|\d+\s*分|\d+\s*タイトル|\d+\s*人|\d+\s*P|\d+\s*連発|VS|ＶＳ|大会|企画|新人NO\.?1|NO\.?1STYLE|ナンバーワンスタイル|ひ・と・き・わ|ドキュメント|Gonzo Document|特化|Complete|コンプリート)/i.test(text);
}

function isBrandSceneRisk(video) {
  const text = [
    video.maker_name,
    video.label_name,
    video.series_name,
  ].filter(Boolean).join(" ");
  return /(FALENO|S1|エスワン|kawaii|MOODYZ)/i.test(text);
}

async function visualMetrics(file) {
  if (!file) return null;
  try {
    const { data, info } = await sharp(file)
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

    for (let y = 1; y < info.height - 1; y += 1) {
      for (let x = 1; x < info.width - 1; x += 1) {
        const i = (y * info.width + x) * info.channels;
        const right = (y * info.width + x + 1) * info.channels;
        const left = (y * info.width + x - 1) * info.channels;
        const up = ((y - 1) * info.width + x) * info.channels;
        const down = ((y + 1) * info.width + x) * info.channels;
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

        const maxChannel = Math.max(data[i], data[i + 1], data[i + 2]);
        const minChannel = Math.min(data[i], data[i + 1], data[i + 2]);
        saturationSum += maxChannel - minChannel;
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
    };
  } catch {
    return null;
  }
}

async function imageDistance(fileA, fileB) {
  if (!fileA || !fileB) return Number.POSITIVE_INFINITY;
  try {
    const [a, b] = await Promise.all([
      sharp(fileA)
        .resize(72, 108, { fit: "contain", background: "#eeeeee" })
        .removeAlpha()
        .raw()
        .toBuffer(),
      sharp(fileB)
        .resize(72, 108, { fit: "contain", background: "#eeeeee" })
        .removeAlpha()
        .raw()
        .toBuffer(),
    ]);
    const length = Math.min(a.length, b.length);
    let diff = 0;
    for (let i = 0; i < length; i += 1) {
      diff += Math.abs(a[i] - b[i]);
    }
    return diff / Math.max(length, 1);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

async function scoreSampleCandidate(video, url, index) {
  const code = video.product_code;
  const forcedSampleUrl = FORCE_SAMPLE_URL.get(code);
  if (forcedSampleUrl && url === forcedSampleUrl) {
    return { url, score: 120, type: "サンプル", reason: "指定済みの作品内容入りサンプル画像" };
  }
  if (index === 0 && FORCE_SAMPLE_FIRST.has(code)) {
    return { url, score: 110, type: "サンプル", reason: "確認済みのポスター風サンプル1枚目" };
  }

  const file = await download(url, code, `sample-${index + 1}`);
  const dim = await dimensions(file);
  if (!dim) return { url, score: 0, type: "サンプル", reason: "画像寸法を確認できない" };
  const visual = await visualMetrics(file);

  let score = 0;
  const vertical = dim.height > dim.width;
  const posterRatio = dim.width / dim.height >= 0.58 && dim.width / dim.height <= 0.88;
  const hasIdentitySignal = hasStrongIdentityText(video);
  const designLikeVertical = vertical
    && posterRatio
    && (visual?.topBottomEdgeDensity ?? 0) >= 0.1
    && (
      hasIdentitySignal
      || (visual?.edgeDensity ?? 0) >= 0.14
      || (visual?.seamStrength ?? 0) >= 95
    );
  const denseJacketLike = (visual?.edgeDensity ?? 0) >= 0.18
    && (visual?.topBottomEdgeDensity ?? 0) >= 0.17
    && (visual?.seamStrength ?? 0) >= 100;
  const informationDesignLike = designLikeVertical || denseJacketLike;
  if (vertical) score += 20;
  if (posterRatio) score += 16;
  if (dim.height >= 600 || dim.width >= 600) score += 8;
  if (hasIdentitySignal) score += 22;
  if (isEnsemble(video)) score += 10;
  if (visual?.edgeDensity >= 0.16) score += 28;
  else if (visual?.edgeDensity >= 0.12) score += 18;
  else if (visual?.edgeDensity >= 0.09) score += 10;
  if (visual?.topBottomEdgeDensity >= 0.18) score += 30;
  else if (visual?.topBottomEdgeDensity >= 0.12) score += 20;
  else if (visual?.topBottomEdgeDensity >= 0.09) score += 10;
  if (visual?.topBottomLift >= 1.3) score += 12;
  if (visual?.seamStrength >= 120) score += 18;
  else if (visual?.seamStrength >= 80) score += 10;
  if (visual?.saturation >= 45) score += 6;
  if (index === 0) score += 5;
  if (index > 0) score -= Math.min(index * 2, 18);

  // ブランドロゴ＋普通の場面写真になりやすいメーカーは、明示確認済み以外では
  // 自動サンプル採用のハードルを少し上げる。画像自体に十分な情報密度があれば採用する。
  if (isBrandSceneRisk(video) && score < 80) score -= 18;

  const plainSceneLike = !vertical
    && (visual?.topBottomEdgeDensity ?? 0) < 0.1
    && (visual?.seamStrength ?? 0) < 80;
  if (plainSceneLike) score -= 34;

  const weakIdentity = !hasIdentitySignal && !FORCE_SAMPLE_FIRST.has(code) && !FORCE_SAMPLE_URL.has(code);
  if (weakIdentity) score = Math.min(score, 58);

  if (!informationDesignLike && !FORCE_SAMPLE_URL.has(code)) {
    score = Math.min(score, 58);
  }

  const weakLandscape = !vertical
    && (visual?.topBottomEdgeDensity ?? 0) < 0.14
    && (visual?.seamStrength ?? 0) < 110;
  if (weakLandscape) score = Math.min(score, 58);

  // 後方サンプルは通常プレイ写真であることが多い。
  // 「作品内容が一瞬で伝わる」水準の構図でない限り、DVD右表紙へ戻す。
  if (index >= 12 && !FORCE_SAMPLE_URL.has(code)) {
    const lateSampleIsClearlyDesigned = informationDesignLike
      && hasIdentitySignal
      && (visual?.topBottomEdgeDensity ?? 0) >= 0.2
      && (visual?.edgeDensity ?? 0) >= 0.18;
    if (!lateSampleIsClearlyDesigned || score < 100) score = Math.min(score, 58);
  }

  const ensembleButNotProjectLike = isEnsemble(video)
    && vertical
    && (visual?.seamStrength ?? 0) < 115
    && (visual?.topBottomEdgeDensity ?? 0) < 0.16;
  if (ensembleButNotProjectLike) {
    score = Math.min(score, 58);
  }

  return {
    url,
    score,
    type: "サンプル",
    reason: `サンプル${index + 1}を画像構図でスコア評価(${score})`,
  };
}

async function bestSampleCandidate(video, samples) {
  const candidates = [];
  for (const [index, url] of samples.entries()) {
    candidates.push(await scoreSampleCandidate(video, url, index));
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0] ?? null;
  return best && best.score >= SAMPLE_ACCEPT_SCORE ? best : null;
}

async function bestSameDesignSample(video, samples, rightCoverFile) {
  if (!rightCoverFile) return null;
  const candidates = [];
  for (const [index, url] of samples.entries()) {
    const file = await download(url, video.product_code, `sample-${index + 1}`);
    const dim = await dimensions(file);
    const distance = await imageDistance(file, rightCoverFile);
    const quality = await scoreSampleCandidate(video, url, index);
    if (
      distance <= SAME_DESIGN_DISTANCE
      && dim
      && dim.width >= 500
      && dim.height >= 500
      && quality.score >= SAMPLE_ACCEPT_SCORE
    ) {
      candidates.push({
        url,
        score: Math.round(140 - distance),
        type: "サンプル",
        reason: `DVD右表紙と同デザインのサンプル${index + 1}を優先(distance ${distance.toFixed(1)})`,
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] ?? null;
}

function isEnsemble(video) {
  const text = [
    video.title,
    video.series_name,
    video.genre,
    video.label_name,
  ].filter(Boolean).join(" ");
  return /(BEST|ベスト|総集編|オムニバス|大人数|共演|出演|女優.*人|人出演|祭|大会)/i.test(text);
}

async function ensureDirs() {
  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir(downloadDir, { recursive: true });
}

async function download(url, code, label) {
  if (!isOfficialImage(url) || url.startsWith("/")) return null;
  const ext = path.extname(new URL(url).pathname).split("?")[0] || ".jpg";
  const file = path.join(downloadDir, `${safeCode(code)}-${label}${ext}`);
  try {
    await fs.access(file);
    return file;
  } catch {
    // continue
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 1024) return null;
    await fs.writeFile(file, bytes);
    return file;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function dimensions(file) {
  if (!file) return null;
  try {
    const bytes = await fs.readFile(file);
    let width = 0;
    let height = 0;
    if (bytes.length > 24 && bytes[0] === 0x89 && bytes.toString("ascii", 1, 4) === "PNG") {
      width = bytes.readUInt32BE(16);
      height = bytes.readUInt32BE(20);
    } else if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        while (bytes[offset] === 0xff) offset += 1;
        const marker = bytes[offset++];
        const length = bytes.readUInt16BE(offset);
        if (marker >= 0xc0 && marker <= 0xc3) {
          height = bytes.readUInt16BE(offset + 3);
          width = bytes.readUInt16BE(offset + 5);
          break;
        }
        offset += length;
      }
    }
    return width && height ? { width, height, ratio: width / height } : null;
  } catch {
    return null;
  }
}

async function generateRightCover(video, sourceFile, dim) {
  if (!sourceFile || !dim) return null;
  const code = safeCode(video.product_code);
  const out = path.join(outDir, `${code}-auto-right.jpg`);
  const publicUrl = `/card-thumbnails/${code}-auto-right.jpg`;
  const cropWidth = Math.max(1, Math.min(dim.width, Math.round(dim.height * RIGHT_COVER_CARD_RATIO)));
  const offsetX = Math.max(0, dim.width - cropWidth);
  try {
    await execFileAsync("sips", [
      "-c", String(dim.height), String(cropWidth),
      "--cropOffset", "0", String(offsetX),
      sourceFile,
      "--out", out,
    ]);
    return publicUrl;
  } catch {
    return null;
  }
}

async function generateCenterCover(video, sourceFile, dim) {
  if (!sourceFile || !dim || dim.ratio < 1.25) return null;
  const code = safeCode(video.product_code);
  const out = path.join(outDir, `${code}-auto-center.jpg`);
  const publicUrl = `/card-thumbnails/${code}-auto-center.jpg`;
  const cropWidth = Math.max(1, Math.min(dim.width, Math.round(dim.height * RIGHT_COVER_CARD_RATIO)));
  const offsetX = Math.max(0, Math.round((dim.width - cropWidth) / 2));
  try {
    await execFileAsync("sips", [
      "-c", String(dim.height), String(cropWidth),
      "--cropOffset", "0", String(offsetX),
      sourceFile,
      "--out", out,
    ]);
    return publicUrl;
  } catch {
    return null;
  }
}

function sampleUrls(video) {
  return Array.isArray(video.sample_images)
    ? video.sample_images.filter(isOfficialImage)
    : [];
}

async function decide(video) {
  const samples = sampleUrls(video);
  const current = typeof video.card_thumbnail_url === "string" ? video.card_thumbnail_url : null;
  const code = video.product_code;
  if (PRESERVE_ROTATED.has(code) && current?.includes("-rotated")) {
    return { url: current, type: "90度回転", reason: "既存の90度回転カード専用画像を維持" };
  }

  const thumb = isOfficialImage(video.thumbnail_url) ? video.thumbnail_url : null;
  const plannedRight = thumb ? `/card-thumbnails/${safeCode(code)}-auto-right.jpg` : null;
  const plannedCenter = thumb ? `/card-thumbnails/${safeCode(code)}-auto-center.jpg` : null;

  // Reviewed gold labels are an acceptance contract. Resolve before any
  // heuristic work and generate only the approved crop when it is required.
  const goldDecision = resolveGoldThumbnail({
    label: GOLD_LABELS.get(code),
    currentUrl: current,
    fullUrl: thumb,
    rightUrl: plannedRight,
    centerUrl: plannedCenter,
    samples,
  });
  if (goldDecision?.blocked) {
    throw new Error(`${goldDecision.code}:${goldDecision.message}`);
  }
  if (goldDecision) {
    if (goldDecision.canonicalType === "right" || goldDecision.canonicalType === "center") {
      const thumbFile = thumb ? await download(thumb, code, "thumb") : null;
      const thumbDim = await dimensions(thumbFile);
      const generated = goldDecision.canonicalType === "right"
        ? await generateRightCover(video, thumbFile, thumbDim)
        : await generateCenterCover(video, thumbFile, thumbDim);
      if (!generated) throw new Error(`GOLD_SOURCE_UNAVAILABLE:${code}:${goldDecision.source}`);
      return { ...goldDecision, url: generated };
    }
    return goldDecision;
  }

  const thumbFile = thumb ? await download(thumb, code, "thumb") : null;
  const thumbDim = await dimensions(thumbFile);
  let rightCover = null;
  let rightCoverFile = null;
  if (thumb && thumbDim && thumbDim.ratio >= 1.25) {
    rightCover = await generateRightCover(video, thumbFile, thumbDim);
    rightCoverFile = rightCover ? path.join(outDir, `${safeCode(code)}-auto-right.jpg`) : null;
  }

  const sample1 = samples[0] ?? null;
  const sameDesignSample = await bestSameDesignSample(video, samples, rightCoverFile);
  if (sameDesignSample) {
    return sameDesignSample;
  }

  const bestSample = await bestSampleCandidate(video, samples);
  if (bestSample && !FORCE_RIGHT_COVER.has(code)) {
    return bestSample;
  }

  if (FORCE_DVD_FULL_CONTEXT.has(code) && thumb) {
    return { url: thumb, type: "DVD全面", reason: "サンプル決定打なし。右側表紙だけでは企画感が落ちるためDVD全面" };
  }

  if (FORCE_RIGHT_COVER.has(code) && thumb && thumbDim && thumbDim.ratio >= 1.25) {
    if (rightCover) return { url: rightCover, type: "右側表紙", reason: "高品質サンプルなし。確認済みのDVD右側表紙を優先" };
  }

  if (thumb && thumbDim && thumbDim.height / thumbDim.width >= 1.12) {
    return { url: thumb, type: "縦長", reason: "縦長パッケージ" };
  }

  if (thumb && thumbDim && thumbDim.ratio >= 1.25) {
    if (rightCover) return { url: rightCover, type: "右側表紙", reason: "横長DVD画像の右側表紙を生成" };
  }

  if (thumb) return { url: thumb, type: "DVD全面", reason: "右側切り出しに向かないためDVD全面" };
  if (sample1) return { url: sample1, type: "サンプル", reason: "パッケージ不在のため公式サンプル画像" };
  return { url: null, type: "NOW PRINTING", reason: "利用可能な公式画像なし" };
}

async function main() {
  const databaseUrl = process.env.SUPABASE_DB_URL;
  if (!databaseUrl) throw new Error("SUPABASE_DB_URL is required");
  await ensureDirs();
  const sql = postgres(databaseUrl, { max: 1, ssl: "require" });
  const limitSql = max > 0 ? sql`limit ${max}` : sql``;
  let videos = await sql`
    select id, product_code, title, actress_name, maker_name, series_name, label_name, genre,
           thumbnail_url, card_thumbnail_url, sample_images
    from videos
    where is_published = true
    order by created_at desc
    ${limitSql}
  `;
  if (targetCodes.size > 0) {
    videos = videos.filter((video) => targetCodes.has(video.product_code));
  }

  // Full automatic runs fail before any image write or DB update when the
  // reviewed contract cannot be resolved from the current candidate inputs.
  // Targeted repair runs are intentionally limited to their requested codes.
  if (targetCodes.size === 0 && max === 0) {
    const byCode = new Map(videos.map((video) => [video.product_code, video]));
    const preflight = new Map();
    for (const label of GOLD_LABELS.values()) {
      const video = byCode.get(label.productCode);
      if (!video) {
        preflight.set(label.productCode, { blocked: true, canonicalType: "missing", source: "" });
        continue;
      }
      const samples = sampleUrls(video);
      preflight.set(label.productCode, resolveGoldThumbnail({
        label,
        currentUrl: typeof video.card_thumbnail_url === "string" ? video.card_thumbnail_url : null,
        fullUrl: isOfficialImage(video.thumbnail_url) ? video.thumbnail_url : null,
        rightUrl: isOfficialImage(video.thumbnail_url) ? `/card-thumbnails/${safeCode(video.product_code)}-auto-right.jpg` : null,
        centerUrl: isOfficialImage(video.thumbnail_url) ? `/card-thumbnails/${safeCode(video.product_code)}-auto-center.jpg` : null,
        samples,
      }));
    }
    assertGoldAcceptance(preflight, GOLD_LABELS);
  }

  const decisions = [];
  for (const video of videos) {
    const decision = await decide(video);
    const previous = video.card_thumbnail_url ?? null;
    const changed = previous !== decision.url;
    decisions.push({
      id: video.id,
      product_code: video.product_code,
      title: video.title,
      previous,
      next: decision.url,
      type: decision.type,
      reason: decision.reason,
      changed,
    });
  }

  if (!dryRun) {
    for (const item of decisions.filter((item) => item.changed)) {
      await sql`update videos set card_thumbnail_url = ${item.next} where id = ${item.id}`;
    }
  }

  const summary = {
    dryRun,
    total: videos.length,
    changed: decisions.filter((item) => item.changed).length,
    sample: decisions.filter((item) => item.type === "サンプル").length,
    rightCover: decisions.filter((item) => item.type === "右側表紙").length,
    dvdFull: decisions.filter((item) => item.type === "DVD全面").length,
    vertical: decisions.filter((item) => item.type === "縦長").length,
    rotated: decisions.filter((item) => item.type === "90度回転").length,
    nowPrinting: decisions.filter((item) => item.type === "NOW PRINTING").length,
    needsReview: decisions.filter((item) => item.type === "NOW PRINTING").length,
    examples: decisions.filter((item) => item.changed).slice(0, 10).map((item) => ({
      product_code: item.product_code,
      type: item.type,
      next: item.next,
      reason: item.reason,
    })),
    checkedCodes: decisions
      .filter((item) => FORCE_SAMPLE_FIRST.has(item.product_code) || FORCE_RIGHT_COVER.has(item.product_code))
      .map((item) => ({ product_code: item.product_code, type: item.type, next: item.next })),
    manufacturerLogoOnlyCorrections: decisions.filter((item) =>
      item.changed
      && item.previous?.includes("jp-")
      && item.type === "右側表紙"
      && /^SNOS/i.test(item.product_code)
    ).length,
    ensembleSingleSampleCorrections: decisions.filter((item) =>
      item.changed
      && item.previous?.includes("jp-")
      && item.type === "右側表紙"
      && /(BEST|ベスト|総集編|オムニバス|大人数|共演|出演|女優.*人|人出演|祭|大会)/i.test(item.title ?? "")
    ).length,
  };
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify({ summary, decisions }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  await sql.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
