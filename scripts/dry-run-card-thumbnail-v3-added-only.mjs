import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";
import {
  classifyThumbnailCandidate,
  FULL_RIGHT_REVIEW_GAP,
  THUMBNAIL_CANDIDATE_AUTO_SCORE,
  THUMBNAIL_CANDIDATE_REVIEW_GAP,
} from "./lib/thumbnail-candidate-classification.mjs";

let root = process.cwd();
let outDir = path.join(root, "tmp", "card-thumbnail-v3-dry-run");
let cacheDir = path.join(outDir, "cache");
let reportPath = path.join(outDir, "report.json");
let summaryPath = path.join(outDir, "summary.json");
let networkFetchesByUrl = new Map();
let inFlightImageFetches = new Map();
const emptyNetworkFetchOutcomes = () => ({
  ok: 0,
  status429: 0,
  unexpected5xx: 0,
  timeouts: 0,
  otherFailures: 0,
  active: 0,
  peak: 0,
});
let networkFetchOutcomes = emptyNetworkFetchOutcomes();

const MIN_SAMPLE_SHORT_EDGE = 360;
const MIN_SAMPLE_AREA = 200_000;
const IDEAL_CARD_RATIO = 0.7;
const CROP_RATIO = 0.735;
const AUTO_THRESHOLD = 58;
const HIGH_CONF_DELTA = 24;
const MEDIUM_CONF_DELTA = 12;
const AMBIGUOUS_GAP = 8;
const SAMPLE_SCORE_OFFSET = -20;
const SAMPLE_INFORMATION_DISCOUNT = 0.5;
const SAMPLE_JACKET_DISCOUNT = 0.5;
const FULL_INFORMATION_ALLOWANCE = 16;

const REPRESENTATIVE_CODES = new Set([
  "H_1784FTO00064",
  "H_1784FT000064",
  "1SBP00417",
  "H_1784FTO00062",
  "H_1784FT000062",
  "1FCDSS00115",
  "AQUCO00184",
  "BEBL00057",
  "1MGNL00178",
  "AQUGL00004",
  "H_1780GPPBY00023",
  "1SBP00400",
]);

export function configureThumbnailCandidateV3({
  repositoryRoot = root,
  outputDirectory = path.join(repositoryRoot, "tmp", "card-thumbnail-v3-dry-run"),
  cacheDirectory = path.join(outputDirectory, "cache"),
} = {}) {
  root = path.resolve(repositoryRoot);
  outDir = path.resolve(outputDirectory);
  cacheDir = path.resolve(cacheDirectory);
  reportPath = path.join(outDir, "report.json");
  summaryPath = path.join(outDir, "summary.json");
  networkFetchesByUrl = new Map();
  inFlightImageFetches = new Map();
  networkFetchOutcomes = emptyNetworkFetchOutcomes();
  return Object.freeze({ root, outDir, cacheDir, reportPath, summaryPath });
}

export function getThumbnailCandidateV3FetchStats() {
  const duplicateNetworkGets = [...networkFetchesByUrl.values()]
    .reduce((total, count) => total + Math.max(0, count - 1), 0);
  return Object.freeze({
    uniqueNetworkGets: networkFetchesByUrl.size,
    totalNetworkGets: [...networkFetchesByUrl.values()].reduce((total, count) => total + count, 0),
    duplicateNetworkGets,
    successfulNetworkGets: networkFetchOutcomes?.ok ?? 0,
    status429: networkFetchOutcomes?.status429 ?? 0,
    unexpected5xx: networkFetchOutcomes?.unexpected5xx ?? 0,
    timeouts: networkFetchOutcomes?.timeouts ?? 0,
    otherFailures: networkFetchOutcomes?.otherFailures ?? 0,
    peakNetworkConcurrency: networkFetchOutcomes?.peak ?? 0,
    cacheRaceCount: duplicateNetworkGets,
    urls: Object.freeze([...networkFetchesByUrl.keys()]),
  });
}

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

function fileNameOf(url) {
  if (!url) return "";
  if (url.startsWith("generated:")) return url;
  if (isLocalCard(url)) return url;
  try {
    return path.basename(new URL(url).pathname);
  } catch {
    return url;
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
  const missing = `${file}.missing`;
  await fs.mkdir(cacheDir, { recursive: true });
  try {
    return await fs.readFile(file);
  } catch {
    // fetch below
  }
  try {
    await fs.access(missing);
    return null;
  } catch {
    // A prior successful cache entry or first request continues below.
  }
  if (!inFlightImageFetches.has(url)) {
    inFlightImageFetches.set(url, (async () => {
      networkFetchesByUrl.set(url, (networkFetchesByUrl.get(url) ?? 0) + 1);
      networkFetchOutcomes.active += 1;
      networkFetchOutcomes.peak = Math.max(networkFetchOutcomes.peak, networkFetchOutcomes.active);
      try {
        const response = await fetch(url, {
          headers: { accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8" },
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) {
          if (response.status === 429) networkFetchOutcomes.status429 += 1;
          else if (response.status >= 500) networkFetchOutcomes.unexpected5xx += 1;
          else networkFetchOutcomes.otherFailures += 1;
          await fs.writeFile(missing, `${response.status}\n`);
          return null;
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > 0) {
          await fs.writeFile(file, buffer);
          networkFetchOutcomes.ok += 1;
          return buffer;
        }
        networkFetchOutcomes.otherFailures += 1;
        await fs.writeFile(missing, "empty\n");
        return null;
      } catch (error) {
        if (error?.name === "TimeoutError" || error?.name === "AbortError") networkFetchOutcomes.timeouts += 1;
        else networkFetchOutcomes.otherFailures += 1;
        await fs.writeFile(missing, `${error?.name ?? "fetch_error"}\n`);
        return null;
      } finally {
        networkFetchOutcomes.active -= 1;
      }
    })());
  }
  return inFlightImageFetches.get(url);
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

function round(value) {
  return Number(value.toFixed(3));
}

async function visualMetrics(buffer) {
  const { data, info } = await sharp(buffer)
    .resize(180, 240, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let edgeCount = 0;
  let topBottomEdgeCount = 0;
  let centerEdgeCount = 0;
  let leftRightEdgeCount = 0;
  let count = 0;
  let topBottomCount = 0;
  let centerCount = 0;
  let leftRightCount = 0;
  let saturationSum = 0;
  let skinLike = 0;
  let extreme = 0;
  const seamScores = [];

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
      const isLeftRight = x < info.width * 0.18 || x > info.width * 0.82;
      if (isTopBottom) {
        if (isEdge) topBottomEdgeCount += 1;
        topBottomCount += 1;
      } else {
        if (isEdge) centerEdgeCount += 1;
        centerCount += 1;
      }
      if (isLeftRight) {
        if (isEdge) leftRightEdgeCount += 1;
        leftRightCount += 1;
      }

      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      saturationSum += max - min;
      if (r > 95 && g > 45 && b > 25 && r > g * 1.05 && r > b * 1.18 && max - min > 15) {
        skinLike += 1;
      }
      const luma = (r + g + b) / 3;
      if (luma < 25 || luma > 235) extreme += 1;
    }
  }

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
  const leftRightEdgeDensity = leftRightEdgeCount / Math.max(leftRightCount, 1);
  return {
    edgeDensity,
    topBottomEdgeDensity,
    centerEdgeDensity,
    leftRightEdgeDensity,
    topBottomLift: topBottomEdgeDensity / Math.max(centerEdgeDensity, 0.001),
    leftRightLift: leftRightEdgeDensity / Math.max(edgeDensity, 0.001),
    saturation: saturationSum / Math.max(count, 1),
    seamStrength: seamScores[0] ?? 0,
    skinRatio: skinLike / Math.max(count, 1),
    flatExtremeRatio: extreme / Math.max(count, 1),
  };
}

function textSignal(video) {
  return [video.title, video.series_name, video.genre, video.label_name, video.maker_name]
    .filter(Boolean)
    .join(" ");
}

function hasIdentitySignal(video) {
  return /(BEST|ベスト|総集編|デビュー|初撮り|周年|VR|4K|8K|MONSTER|モンスター|ハーレム|先生|内申点|天使|応援|ラウンジ|\d+\s*分|\d+\s*時間|\d+\s*作品|\d+\s*本番|\d+\s*タイトル|\d+\s*人|\d+\s*P|\d+\s*連発|VS|ＶＳ|大会|企画|新人|NO\.?1|ナンバーワン|ひ・と・き・わ|ドキュメント|Gonzo Document|特化|Complete|コンプリート|シロウト|モニタリング|寝取|NTR|中出し|オムニバス)/i.test(textSignal(video));
}

function isEnsembleOrCompilation(video) {
  return /(BEST|ベスト|総集編|オムニバス|大人数|共演|出演|女優.*人|人出演|祭|大会|\d+\s*人|\d+\s*作品|\d+\s*本番|\d+\s*時間|\d+\s*分)/i.test(textSignal(video));
}

function classifyCurrent(url, thumbnailUrl, sampleImages) {
  if (!url) return "missing";
  if (url === thumbnailUrl) return "dvd_full";
  if (sampleImages.includes(url)) return "sample";
  if (isLocalCard(url) && url.includes("auto-center")) return "dvd_center";
  if (isLocalCard(url) && /(?:auto-right|right-auto|right-final)/.test(url)) return "dvd_right";
  if (isLocalCard(url) && url.includes("rotated")) return "rotated";
  if (isLocalCard(url)) return "local_card";
  return "other";
}

async function cropCandidateBuffer(thumbnailBuffer, position) {
  const meta = await imageMetaFromBuffer(thumbnailBuffer);
  if (!meta || meta.ratio < 1.15) return null;
  const cropWidth = Math.max(1, Math.min(meta.width, Math.round(meta.height * CROP_RATIO)));
  const left = position === "center"
    ? Math.max(0, Math.round((meta.width - cropWidth) / 2))
    : Math.max(0, meta.width - cropWidth);
  const buffer = await sharp(thumbnailBuffer)
    .extract({ left, top: 0, width: Math.min(cropWidth, meta.width - left), height: meta.height })
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer();
  return { buffer, left, cropWidth };
}

function componentScores({ candidate, meta, visual, video }) {
  const ratioDistance = Math.abs(meta.ratio - IDEAL_CARD_RATIO);
  const cardFit = Math.max(0, Math.round(24 - ratioDistance * 24));
  const posterShape = meta.ratio >= 0.55 && meta.ratio <= 0.9;
  const identity = hasIdentitySignal(video);
  const ensemble = isEnsembleOrCompilation(video);

  const informationDense =
    visual.edgeDensity >= 0.15
    && visual.topBottomEdgeDensity >= 0.13
    && visual.seamStrength >= 80
    && visual.skinRatio < 0.66;
  const jacketFeel =
    posterShape
    && visual.edgeDensity >= 0.1
    && visual.topBottomEdgeDensity >= 0.095
    && visual.skinRatio < 0.62
    && visual.flatExtremeRatio < 0.42;
  const plainScene =
    visual.edgeDensity < 0.095
    && visual.topBottomEdgeDensity < 0.09
    && visual.seamStrength < 85;
  const bodyPartOrClose =
    visual.skinRatio >= 0.58
    && visual.topBottomEdgeDensity < 0.13
    && visual.seamStrength < 95;
  const faceOnlyLike =
    visual.skinRatio >= 0.45
    && visual.edgeDensity < 0.11
    && visual.flatExtremeRatio < 0.18;
  const cropLooksCut =
    candidate.type === "dvd_right" || candidate.type === "dvd_center"
      ? visual.skinRatio >= 0.6 && visual.topBottomEdgeDensity < 0.12
      : false;
  const sideBandOrBlur =
    visual.flatExtremeRatio > 0.34 || visual.leftRightLift < 0.78 || visual.leftRightLift > 1.35;

  let explanationPower = 0;
  if (identity) explanationPower += 14;
  if (informationDense) explanationPower += 24;
  if (jacketFeel) explanationPower += 16;
  if (visual.topBottomLift >= 1.25) explanationPower += 6;
  if (visual.seamStrength >= 120) explanationPower += 8;
  else if (visual.seamStrength >= 90) explanationPower += 4;
  if (ensemble && candidate.type === "dvd_full" && informationDense) explanationPower += 12;
  if (candidate.type === "dvd_full" && sideBandOrBlur && informationDense) explanationPower += 8;
  explanationPower = Math.min(70, explanationPower);

  let personCut = 0;
  if (cropLooksCut) personCut += 24;
  if (candidate.type === "dvd_right" && ensemble && visual.skinRatio >= 0.55 && visual.topBottomLift < 0.8) personCut += 12;
  if (candidate.type === "dvd_center" && visual.skinRatio >= 0.68) personCut += 10;

  let bodyPart = 0;
  if (bodyPartOrClose) bodyPart += 30;
  if (visual.skinRatio >= 0.72) bodyPart += 12;

  let scenePhoto = 0;
  if (plainScene) scenePhoto += 28;
  if (candidate.type === "sample" && !informationDense && !jacketFeel) scenePhoto += 24;
  if (candidate.type === "sample" && faceOnlyLike) scenePhoto += 10;

  let infoDensity = 0;
  if (informationDense) infoDensity += 28;
  if (visual.topBottomEdgeDensity >= 0.18) infoDensity += 8;
  if (visual.edgeDensity >= 0.2) infoDensity += 8;
  if (visual.seamStrength >= 150) infoDensity += 8;

  return {
    explanationPower,
    personCut,
    bodyPart,
    faceOnly: faceOnlyLike ? 18 : 0,
    scenePhoto,
    jacketFeel: jacketFeel ? 24 : 0,
    infoDensity,
    cardFit,
    resolution: meta.shortEdge >= 500 ? 10 : meta.shortEdge >= 360 ? 5 : 0,
    typeHint:
      candidate.type === "vertical_package" ? 6
        : candidate.type === "sample" ? 2
          : candidate.type === "dvd_right" ? 3
            : candidate.type === "dvd_center" ? 1
              : candidate.type === "dvd_full" ? -4
                : 0,
    flags: {
      informationDense,
      jacketFeel,
      plainScene,
      bodyPartOrClose,
      faceOnlyLike,
      sideBandOrBlur,
      cropLooksCut,
      identity,
      ensemble,
    },
  };
}

function scoreCandidate({ candidate, video, meta, visual, lowResolution }) {
  if (lowResolution) {
    return {
      score: -999,
      excluded: true,
      review: false,
      reasons: ["low_resolution_for_card"],
      components: null,
      flags: {},
    };
  }
  const baseComponents = componentScores({ candidate, meta, visual, video });
  const sampleInformationDiscount = candidate.type === "sample"
    ? Math.round(baseComponents.infoDensity * SAMPLE_INFORMATION_DISCOUNT)
    : 0;
  const sampleJacketDiscount = candidate.type === "sample"
    ? Math.round(baseComponents.jacketFeel * SAMPLE_JACKET_DISCOUNT)
    : 0;
  const sampleScoreOffset = candidate.type === "sample" ? SAMPLE_SCORE_OFFSET : 0;
  const fullInformationDiscount = candidate.type === "dvd_full" || candidate.type === "vertical_package"
    ? Math.max(0, baseComponents.infoDensity - FULL_INFORMATION_ALLOWANCE)
    : 0;
  const components = {
    ...baseComponents,
    sampleInformationDiscount,
    sampleJacketDiscount,
    sampleScoreOffset,
    fullInformationDiscount,
  };
  const score =
    components.explanationPower
    + components.jacketFeel
    + components.infoDensity
    + components.cardFit
    + components.resolution
    + components.typeHint
    - components.personCut
    - components.bodyPart
    - components.faceOnly
    - components.scenePhoto
    + components.sampleScoreOffset
    - components.sampleInformationDiscount
    - components.sampleJacketDiscount
    - components.fullInformationDiscount;

  const reasons = [];
  if (components.explanationPower >= 40) reasons.push("strong_explanation_power");
  if (components.infoDensity >= 28) reasons.push("information_dense");
  if (components.jacketFeel >= 24) reasons.push("jacket_like");
  if (components.personCut > 0) reasons.push("person_or_text_cut_risk");
  if (components.bodyPart > 0) reasons.push("body_part_risk");
  if (components.faceOnly > 0) reasons.push("face_only_risk");
  if (components.scenePhoto > 0) reasons.push("plain_scene_risk");
  if (candidate.type === "dvd_center" && components.flags.sideBandOrBlur) reasons.push("center_crop_rescues_side_band");
  if (candidate.type === "dvd_full" && components.flags.ensemble && components.flags.informationDense) reasons.push("dvd_full_preserves_context");
  if (components.sampleInformationDiscount > 0) reasons.push("sample_information_signal_discounted");
  if (components.sampleJacketDiscount > 0) reasons.push("sample_jacket_signal_discounted");
  if (components.fullInformationDiscount > 0) reasons.push("full_information_saturation_discounted");

  const review =
    score < AUTO_THRESHOLD
    || components.bodyPart >= 30
    || components.scenePhoto >= 40
    || (candidate.type === "sample" && components.explanationPower < 32 && components.jacketFeel < 24);

  return {
    score: Math.round(score),
    excluded: false,
    review,
    reasons,
    components,
    flags: components.flags,
  };
}

async function analyzeCandidate(candidate, video) {
  const analysisUrl = candidate.analysisUrl ?? candidate.url;
  const buffer = candidate.buffer ?? await imageBuffer(analysisUrl);
  const meta = await imageMetaFromBuffer(buffer);
  if (!buffer || !meta) return null;
  const visual = await visualMetrics(buffer);
  const lowResolution =
    candidate.type === "sample"
    && !candidate.analysisProxy
    && (meta.shortEdge < MIN_SAMPLE_SHORT_EDGE || meta.area < MIN_SAMPLE_AREA);
  const scored = scoreCandidate({ candidate, video, meta, visual, lowResolution });
  return {
    ...candidate,
    analysisUrl,
    sourceUrl: candidate.sourceUrl ?? candidate.url,
    sourceHash: candidate.sourceHash ?? createHash("sha256").update(buffer).digest("hex"),
    outputHash: createHash("sha256").update(buffer).digest("hex"),
    meta: {
      width: meta.width,
      height: meta.height,
      ratio: round(meta.ratio),
      area: meta.area,
      shortEdge: meta.shortEdge,
    },
    visual: Object.fromEntries(Object.entries(visual).map(([key, value]) => [key, round(value)])),
    ...scored,
  };
}

function samplePairKey(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname.replace(/jp-(\d+)\.jpg$/i, "-$1.jpg");
  } catch {
    return url;
  }
}

function deduplicatedSampleEntries(sampleImages, preferSmallSampleProxy) {
  const byPair = new Map();
  for (const [index, url] of sampleImages.entries()) {
    const key = samplePairKey(url);
    const entry = byPair.get(key) ?? {};
    if (/jp-\d+\.jpg$/i.test(new URL(url).pathname)) entry.source = { index, url };
    else entry.proxy = { index, url };
    byPair.set(key, entry);
  }
  return [...byPair.values()].map((entry) => {
    const source = entry.source ?? entry.proxy;
    const proxy = preferSmallSampleProxy ? entry.proxy ?? source : source;
    return {
      ...source,
      analysisUrl: proxy.url,
      analysisProxy: proxy.url !== source.url,
    };
  }).sort((left, right) => left.index - right.index);
}

export function deduplicatedSampleSourceIndices(sampleImages) {
  const normalized = Array.isArray(sampleImages)
    ? sampleImages.map(normalizeUrl).filter((url) => url && isOfficialImage(url))
    : [];
  return Object.freeze(deduplicatedSampleEntries(normalized, false).map((entry) => entry.index + 1));
}

export function deduplicatedSampleSources(sampleImages) {
  const normalized = Array.isArray(sampleImages)
    ? sampleImages.map(normalizeUrl).filter((url) => url && isOfficialImage(url))
    : [];
  return Object.freeze(deduplicatedSampleEntries(normalized, false).map((entry) => Object.freeze({
    index: entry.index + 1,
    url: entry.url,
  })));
}

export async function decideThumbnailCandidateV3(video, {
  deduplicateSamplePairs = false,
  preferSmallSampleProxy = false,
  sampleConcurrency = 1,
  candidateLimit = 12,
  sampleIndices = null,
} = {}) {
  const sampleImages = Array.isArray(video.sample_images)
    ? video.sample_images.map(normalizeUrl).filter((url) => url && isOfficialImage(url))
    : [];
  const thumbUrl = normalizeUrl(video.thumbnail_url);
  const currentUrl = normalizeUrl(video.card_thumbnail_url);
  const thumbBuffer = thumbUrl ? await imageBuffer(thumbUrl) : null;
  const thumbMeta = await imageMetaFromBuffer(thumbBuffer);
  const thumbHash = thumbBuffer
    ? createHash("sha256").update(thumbBuffer).digest("hex")
    : null;
  const candidates = [];

  if (thumbUrl && thumbBuffer) {
    const full = await analyzeCandidate({ type: "dvd_full", url: thumbUrl, buffer: thumbBuffer }, video);
    if (full) candidates.push(full);
    const right = await cropCandidateBuffer(thumbBuffer, "right");
    if (right) {
      const analyzed = await analyzeCandidate({
        type: "dvd_right",
        url: `generated:${video.product_code}-auto-right.jpg`,
        buffer: right.buffer,
        sourceUrl: thumbUrl,
        sourceHash: thumbHash,
        sourceWidth: thumbMeta?.width ?? null,
        sourceHeight: thumbMeta?.height ?? null,
        cropLeft: right.left,
        cropWidth: right.cropWidth,
      }, video);
      if (analyzed) candidates.push(analyzed);
    }
    const center = await cropCandidateBuffer(thumbBuffer, "center");
    if (center) {
      const analyzed = await analyzeCandidate({
        type: "dvd_center",
        url: `generated:${video.product_code}-auto-center.jpg`,
        buffer: center.buffer,
        sourceUrl: thumbUrl,
        sourceHash: thumbHash,
        sourceWidth: thumbMeta?.width ?? null,
        sourceHeight: thumbMeta?.height ?? null,
        cropLeft: center.left,
        cropWidth: center.cropWidth,
      }, video);
      if (analyzed) candidates.push(analyzed);
    }
    if (thumbMeta && thumbMeta.height > thumbMeta.width && thumbMeta.ratio >= 0.55 && thumbMeta.ratio <= 0.9) {
      const vertical = await analyzeCandidate({ type: "vertical_package", url: thumbUrl, buffer: thumbBuffer }, video);
      if (vertical) candidates.push(vertical);
    }
  }

  const sampleEntries = deduplicateSamplePairs
    ? deduplicatedSampleEntries(sampleImages, preferSmallSampleProxy)
    : sampleImages.map((url, index) => ({ index, url, analysisUrl: url, analysisProxy: false }));
  const selectedSampleIndices = sampleIndices === null
    ? null
    : new Set(sampleIndices.map((value) => Number(value)));
  if (selectedSampleIndices && [...selectedSampleIndices].some((value) =>
    !Number.isInteger(value) || value < 1 || value > sampleImages.length)) {
    throw new Error(`THUMBNAIL_V3_INVALID_SAMPLE_INDEX:${video.product_code}`);
  }
  const selectedSampleEntries = selectedSampleIndices
    ? sampleEntries.filter((entry) => selectedSampleIndices.has(entry.index + 1))
    : sampleEntries;
  const concurrency = Math.max(1, Math.min(6, Math.trunc(sampleConcurrency)));
  for (let offset = 0; offset < selectedSampleEntries.length; offset += concurrency) {
    const batch = selectedSampleEntries.slice(offset, offset + concurrency);
    const samples = await Promise.all(batch.map(({ index, url, analysisUrl, analysisProxy }) =>
      analyzeCandidate({
        type: "sample",
        url,
        analysisUrl,
        analysisProxy,
        sampleIndex: index + 1,
      }, video)));
    candidates.push(...samples.filter(Boolean));
  }

  candidates.sort((a, b) => b.score - a.score);
  while (candidates[0]?.type === "sample" && candidates[0].analysisProxy) {
    const candidate = candidates[0];
    const sourceBuffer = await imageBuffer(candidate.sourceUrl);
    const sourceMeta = await imageMetaFromBuffer(sourceBuffer);
    if (sourceBuffer && sourceMeta) {
      const digest = createHash("sha256").update(sourceBuffer).digest("hex");
      candidate.sourceHash = digest;
      candidate.outputHash = digest;
      candidate.sourceWidth = sourceMeta.width;
      candidate.sourceHeight = sourceMeta.height;
      candidate.analysisProxy = false;
      break;
    }
    candidate.excluded = true;
    candidate.review = true;
    candidate.reasons = [...candidate.reasons, "selected_source_unavailable"];
    candidates.sort((a, b) => Number(a.excluded) - Number(b.excluded) || b.score - a.score);
  }
  const best = candidates[0] ?? null;
  const runnerUp = candidates[1] ?? null;
  const fullCandidate = candidates.find((item) => item.type === "dvd_full") ?? null;
  const rightCandidate = candidates.find((item) => item.type === "dvd_right") ?? null;
  const currentType = classifyCurrent(currentUrl, thumbUrl, sampleImages);
  const currentCandidate = currentType === "dvd_right"
    ? candidates.find((item) => item.type === "dvd_right")
    : currentType === "dvd_center"
      ? candidates.find((item) => item.type === "dvd_center")
      : candidates.find((item) => item.url === currentUrl)
        ?? (currentType === "dvd_full" ? candidates.find((item) => item.type === "dvd_full") : null);
  const centerEligible =
    best?.type !== "dvd_center"
    || Boolean(fullCandidate?.flags?.sideBandOrBlur)
    || Boolean(rightCandidate?.flags?.cropLooksCut)
    || Boolean(rightCandidate?.flags?.bodyPartOrClose)
    || Boolean(rightCandidate && rightCandidate.score < AUTO_THRESHOLD);
  const decisionGate = classifyThumbnailCandidate({
    best,
    runnerUp,
    rightCandidate,
    sampleCandidateAvailable: candidates.some((item) => item.type === "sample" && !item.excluded),
    centerEligible,
  });
  const needsReview = decisionGate.needs_review;
  const nextType = needsReview ? "needs_review" : best.type;
  const nextUrl = needsReview ? currentUrl : best.type === "dvd_right"
    ? `/card-thumbnails/${video.product_code}-auto-right.jpg`
    : best.type === "dvd_center"
      ? `/card-thumbnails/${video.product_code}-auto-center.jpg`
      : best.url;
  const changed = Boolean(!needsReview && currentUrl !== nextUrl);
  const currentScore = currentCandidate?.score ?? null;
  const scoreDelta = changed && currentScore !== null && best ? best.score - currentScore : null;
  const confidence = decisionGate.confidence;

  return {
    product_code: video.product_code,
    title: video.title,
    current_url: currentUrl,
    current_file: fileNameOf(currentUrl),
    current_type: currentType,
    current_score: currentScore,
    next_url: nextUrl,
    next_file: fileNameOf(nextUrl),
    next_type: nextType,
    next_score: best?.score ?? null,
    score_delta: scoreDelta,
    changed,
    needs_review: needsReview,
    confidence,
    reason: needsReview
      ? decisionGate.reason_codes.join(",").toLowerCase()
      : best.reasons.join(",") || "highest_total_score",
    decision_gate: decisionGate,
    low_resolution_excluded: candidates.filter((item) => item.excluded).length,
    center_candidate_available: candidates.some((item) => item.type === "dvd_center"),
    center_candidate_won: best?.type === "dvd_center",
    center_candidate_eligible: centerEligible,
    dvd_full_candidate_won: best?.type === "dvd_full",
    current_plain_or_bodypart: Boolean(currentCandidate?.flags?.plainScene || currentCandidate?.flags?.bodyPartOrClose || currentCandidate?.flags?.faceOnlyLike),
    candidates: candidates.slice(0, candidateLimit === null ? candidates.length : candidateLimit).map((item) => ({
      type: item.type,
      url: item.url,
      file: fileNameOf(item.url),
      sampleIndex: item.sampleIndex ?? null,
      score: item.score,
      excluded: item.excluded,
      review: item.review,
      reasons: item.reasons,
      components: item.components,
      flags: item.flags,
      meta: item.meta,
      visual: item.visual,
      cropLeft: item.cropLeft ?? null,
      cropWidth: item.cropWidth ?? null,
      sourceUrl: item.sourceUrl,
      sourceHash: item.sourceHash,
      outputHash: item.outputHash,
      sourceWidth: item.sourceWidth ?? item.meta?.width ?? null,
      sourceHeight: item.sourceHeight ?? item.meta?.height ?? null,
      analysisUrl: item.analysisUrl,
      analysisProxy: item.analysisProxy ?? false,
    })),
  };
}

function tally(rows) {
  const byNextType = {};
  const byCurrentType = {};
  const byConfidence = {};
  for (const row of rows) {
    byNextType[row.next_type] = (byNextType[row.next_type] ?? 0) + 1;
    byCurrentType[row.current_type] = (byCurrentType[row.current_type] ?? 0) + 1;
    byConfidence[row.confidence] = (byConfidence[row.confidence] ?? 0) + 1;
  }
  return {
    total: rows.length,
    changed: rows.filter((row) => row.changed).length,
    unchanged: rows.filter((row) => !row.changed && !row.needs_review).length,
    needs_review: rows.filter((row) => row.needs_review).length,
    low_resolution_excluded: rows.filter((row) => row.low_resolution_excluded > 0).length,
    center_candidates_available: rows.filter((row) => row.center_candidate_available).length,
    center_wins: rows.filter((row) => row.center_candidate_won).length,
    dvd_full_wins: rows.filter((row) => row.dvd_full_candidate_won).length,
    current_plain_or_bodypart: rows.filter((row) => row.current_plain_or_bodypart).length,
    by_next_type: byNextType,
    by_current_type: byCurrentType,
    by_confidence: byConfidence,
  };
}

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) throw new Error("Supabase environment variables are required");
  await fs.mkdir(cacheDir, { recursive: true });

  const addedReportPath = path.join(root, "tmp", "publish-1000", "published-codes.json");
  const addedCodes = new Set(JSON.parse(await fs.readFile(addedReportPath, "utf8")).codes ?? []);
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data, error } = await supabase
    .from("videos")
    .select("product_code,title,maker_name,series_name,label_name,genre,thumbnail_url,card_thumbnail_url,sample_images,is_published,created_at")
    .eq("is_published", true)
    .order("created_at", { ascending: true })
    .limit(2_000);
  if (error) throw error;

  const existingCount = (data ?? []).filter((video) => !addedCodes.has(video.product_code)).length;
  const addedVideos = (data ?? []).filter((video) => addedCodes.has(video.product_code));
  const rows = [];
  const representatives = {};
  let processed = 0;
  for (const video of addedVideos) {
    const row = await decideThumbnailCandidateV3(video);
    rows.push(row);
    if (REPRESENTATIVE_CODES.has(video.product_code)) representatives[video.product_code] = row;
    processed += 1;
    if (processed % 100 === 0) console.log(JSON.stringify({ processed, total: addedVideos.length }));
  }

  const report = {
    generated_at: new Date().toISOString(),
    mode: "dry-run-added700-only-no-db-update-no-image-write",
    existing300: {
      total: existingCount,
      policy: "完全固定。v3では評価・変更対象外。",
    },
    thresholds: {
      min_sample_short_edge: MIN_SAMPLE_SHORT_EDGE,
      min_sample_area: MIN_SAMPLE_AREA,
      ideal_card_ratio: IDEAL_CARD_RATIO,
      crop_ratio: CROP_RATIO,
      auto_threshold: AUTO_THRESHOLD,
      ambiguous_gap: AMBIGUOUS_GAP,
      candidate_auto_score: THUMBNAIL_CANDIDATE_AUTO_SCORE,
      candidate_review_gap: THUMBNAIL_CANDIDATE_REVIEW_GAP,
      full_right_review_gap: FULL_RIGHT_REVIEW_GAP,
      high_conf_delta: HIGH_CONF_DELTA,
      medium_conf_delta: MEDIUM_CONF_DELTA,
    },
    added700: {
      summary: tally(rows),
      rows,
    },
    representatives,
  };
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));

  const compact = {
    report: reportPath,
    existing300: report.existing300,
    thresholds: report.thresholds,
    added700: report.added700.summary,
    high_auto_candidates: rows.filter((row) => row.changed && row.confidence === "high").map((row) => ({
      product_code: row.product_code,
      current_type: row.current_type,
      next_type: row.next_type,
      current_score: row.current_score,
      next_score: row.next_score,
      reason: row.reason,
    })),
    representatives: Object.fromEntries(Object.entries(representatives).map(([code, row]) => [
      code,
      {
        current_type: row.current_type,
        current_score: row.current_score,
        next_type: row.next_type,
        next_score: row.next_score,
        changed: row.changed,
        needs_review: row.needs_review,
        confidence: row.confidence,
        reason: row.reason,
        top_candidates: row.candidates.slice(0, 5).map((item) => ({
          type: item.type,
          file: item.file,
          score: item.score,
          reasons: item.reasons,
          components: item.components,
          flags: item.flags,
        })),
      },
    ])),
  };
  await fs.writeFile(summaryPath, JSON.stringify(compact, null, 2));
  console.log(JSON.stringify(compact, null, 2));
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
