import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";

const root = process.cwd();
const dryRun = process.argv.includes("--dry-run");
const outDir = path.join(root, "public", "card-thumbnails");
const tmpDir = path.join(root, "tmp", "card-thumbnail-v3-apply-60");
const cacheDir = path.join(root, "tmp", "card-thumbnail-v3-dry-run", "cache");
const reportPath = path.join(root, "tmp", "card-thumbnail-v3-dry-run", "report.json");
const reviewPath = path.join(root, "tmp", "card-thumbnail-v3-review", "review-results.json");
const applyReportPath = path.join(tmpDir, dryRun ? "dry-run-report.json" : "apply-report.json");

const APPROVED_CODES = [
  "ROE00515",
  "ROE00520",
  "DSOD00048",
  "ROE00526",
  "SQTE00701",
  "JUR00092",
  "IPZZ00909",
  "IPZZ00870",
  "IPOK00026",
  "MVSD00701",
  "FWAY00100",
  "KAGP00400",
  "AUKG00655",
  "PRED00879",
  "BASJ00045",
  "BACJ00187",
  "BACJ00183",
  "MNGS00065",
  "MKCK00426",
  "MNGS00064",
  "MIDA00718",
  "SNOS00303",
  "SNOS00245",
  "SNOS00286",
  "SNOS00258",
  "VRKM01830",
  "301MBDD02185",
  "EBWH00344",
  "13DSVR01975",
  "TNJS00006",
  "H_1834TK00085",
  "MBYD00428",
  "MFYD00160",
  "MIDA00700",
  "MFYD00162",
  "MFYD00165",
  "MIDA00645",
  "H_068MXGS01438",
  "H_068MXDLP00336",
  "JUVR00300",
  "BBSS00104",
  "BBAN00592",
  "KAVR00502",
  "1IENF00455",
  "H_346REBD01047",
  "H_346REBD01048",
  "H_346REBD01049",
  "PXVR00461",
  "PXVR00456",
  "125UMD01013",
  "DVRT07702",
  "DVRT07701",
  "1SDAB00352",
  "1START00591",
  "1SILK02031",
  "H_283PMFT00438",
  "H_283PMFT00439",
  "PARATHD04490",
  "DSVR00064",
  "5561SGKT00002",
];

const REPRESENTATIVE_CODES = new Set([
  "H_1784FTO00064",
  "1SBP00417",
  "H_1784FTO00062",
  "1FCDSS00115",
  "AQUCO00184",
  "BEBL00057",
]);

const TYPE_SUFFIX = {
  dvd_center: "center",
  dvd_right: "right",
  dvd_full: "full",
  sample: "sample",
  vertical_package: "vertical",
};

await fs.mkdir(tmpDir, { recursive: true });
await fs.mkdir(outDir, { recursive: true });
await fs.mkdir(cacheDir, { recursive: true });

function safeCode(code) {
  return String(code).replace(/[^A-Za-z0-9_-]/g, "_");
}

function hash(value) {
  return createHash("sha1").update(value).digest("hex");
}

function isLocalCard(url) {
  return typeof url === "string" && url.startsWith("/card-thumbnails/");
}

function cachePathForUrl(url) {
  const parsed = new URL(url);
  const ext = path.extname(parsed.pathname) || ".jpg";
  return path.join(cacheDir, `${hash(url)}${ext}`);
}

function fileNameOf(url) {
  if (!url) return "";
  if (url.startsWith("generated:") || isLocalCard(url)) return url;
  try {
    return path.basename(new URL(url).pathname);
  } catch {
    return url;
  }
}

async function officialImageBuffer(url) {
  if (!url) return null;
  if (isLocalCard(url)) {
    try {
      return await fs.readFile(path.join(root, "public", url.replace(/^\//, "")));
    } catch {
      return null;
    }
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "pics.dmm.co.jp") return null;
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
  if (!candidate) return null;
  if (candidate.url?.startsWith("generated:")) {
    const full = row.candidates.find((item) => item.type === "dvd_full");
    if (!full?.url || full.url.startsWith("generated:")) return null;
    const source = await officialImageBuffer(full.url);
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
  return officialImageBuffer(candidate.url);
}

async function metadata(buffer) {
  const meta = await sharp(buffer).metadata();
  return {
    width: meta.width,
    height: meta.height,
    format: meta.format,
    size: buffer.length,
  };
}

function publicUrlFor(code, type) {
  const suffix = TYPE_SUFFIX[type];
  if (!suffix) throw new Error(`unsupported next_type ${type} for ${code}`);
  return `/card-thumbnails/${safeCode(code)}-${suffix}-v3.jpg`;
}

function selectCandidate(row) {
  if (row.next_type === "dvd_right") return row.candidates.find((item) => item.type === "dvd_right");
  if (row.next_type === "dvd_center") return row.candidates.find((item) => item.type === "dvd_center");
  if (row.next_type === "dvd_full") return row.candidates.find((item) => item.type === "dvd_full");
  if (row.next_type === "vertical_package") return row.candidates.find((item) => item.type === "vertical_package");
  if (row.next_type === "sample") {
    return row.candidates.find((item) => item.type === "sample" && item.url === row.next_url)
      ?? row.candidates.find((item) => item.type === "sample" && !item.excluded);
  }
  return null;
}

async function main() {
  const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  const review = JSON.parse(await fs.readFile(reviewPath, "utf8"));
  const approvedSet = new Set(APPROVED_CODES);
  const reviewSet = new Set(review.final_first_pass_candidates ?? review.codes?.A ?? []);
  const rowByCode = new Map(report.added700.rows.map((row) => [row.product_code, row]));
  const duplicateCodes = APPROVED_CODES.filter((code, index) => APPROVED_CODES.indexOf(code) !== index);
  if (APPROVED_CODES.length !== 60 || approvedSet.size !== 60 || duplicateCodes.length) {
    throw new Error(`approved list must be exactly 60 unique codes: ${APPROVED_CODES.length}/${approvedSet.size}`);
  }
  const notInReview = APPROVED_CODES.filter((code) => !reviewSet.has(code));
  const missingRows = APPROVED_CODES.filter((code) => !rowByCode.has(code));
  const representativeOverlap = APPROVED_CODES.filter((code) => REPRESENTATIVE_CODES.has(code));
  if (notInReview.length || missingRows.length || representativeOverlap.length) {
    throw new Error(JSON.stringify({ notInReview, missingRows, representativeOverlap }, null, 2));
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) throw new Error("Supabase environment variables are required");
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: videos, error } = await supabase
    .from("videos")
    .select("id,product_code,card_thumbnail_url,is_published")
    .in("product_code", APPROVED_CODES);
  if (error) throw error;
  if ((videos ?? []).length !== 60) throw new Error(`DB target count mismatch: ${videos?.length ?? 0}`);
  const dbByCode = new Map(videos.map((video) => [video.product_code, video]));

  const plans = [];
  const errors = [];
  for (const code of APPROVED_CODES) {
    const row = rowByCode.get(code);
    const dbVideo = dbByCode.get(code);
    const candidate = selectCandidate(row);
    const nextUrl = publicUrlFor(code, row.next_type);
    const outputPath = path.join(root, "public", nextUrl.replace(/^\//, ""));
    const buffer = await candidateBuffer(row, candidate);
    let meta = null;
    let exists = false;
    try {
      await fs.access(outputPath);
      exists = true;
    } catch {
      exists = false;
    }
    if (!candidate || !buffer) {
      errors.push({ product_code: code, error: "candidate_buffer_missing", next_type: row.next_type });
    } else {
      meta = await metadata(buffer);
    }
    plans.push({
      id: dbVideo?.id,
      product_code: code,
      is_published: dbVideo?.is_published,
      before_url: dbVideo?.card_thumbnail_url ?? null,
      planned_url: nextUrl,
      next_type: row.next_type,
      current_type: row.current_type,
      current_score: row.current_score,
      next_score: row.next_score,
      confidence: row.confidence,
      candidate_source: candidate?.url ?? null,
      candidate_source_file: fileNameOf(candidate?.url),
      output_path: outputPath,
      output_exists_before: exists,
      image_meta: meta,
      will_update: Boolean(candidate && buffer && dbVideo?.card_thumbnail_url !== nextUrl),
    });
  }

  const outsideUpdateCount = 0;
  const blocking = [
    ...errors,
    ...plans.filter((plan) => plan.output_exists_before).map((plan) => ({ product_code: plan.product_code, error: "output_file_already_exists", output_path: plan.output_path })),
    ...plans.filter((plan) => !plan.is_published).map((plan) => ({ product_code: plan.product_code, error: "target_not_published" })),
  ];
  const typeCounts = plans.reduce((acc, plan) => {
    acc[plan.next_type] = (acc[plan.next_type] ?? 0) + 1;
    return acc;
  }, {});

  if (!dryRun && blocking.length) {
    throw new Error(`blocking safety errors:\n${JSON.stringify(blocking, null, 2)}`);
  }

  if (!dryRun) {
    for (const plan of plans) {
      const row = rowByCode.get(plan.product_code);
      const candidate = selectCandidate(row);
      const buffer = await candidateBuffer(row, candidate);
      await sharp(buffer).jpeg({ quality: 92, mozjpeg: true }).toFile(plan.output_path);
      const { error: updateError } = await supabase
        .from("videos")
        .update({ card_thumbnail_url: plan.planned_url })
        .eq("id", plan.id)
        .eq("product_code", plan.product_code);
      if (updateError) throw updateError;
    }
  }

  const applyReport = {
    generated_at: new Date().toISOString(),
    dry_run: dryRun,
    target_count: APPROVED_CODES.length,
    db_target_count: videos.length,
    outside_update_count: outsideUpdateCount,
    type_counts: typeCounts,
    errors,
    blocking,
    plans,
  };
  await fs.writeFile(applyReportPath, JSON.stringify(applyReport, null, 2));
  console.log(JSON.stringify({
    report: applyReportPath,
    dry_run: dryRun,
    target_count: applyReport.target_count,
    db_target_count: applyReport.db_target_count,
    outside_update_count: outsideUpdateCount,
    type_counts: typeCounts,
    errors: errors.length,
    blocking: blocking.length,
    will_update: plans.filter((plan) => plan.will_update).length,
    codes: plans.map((plan) => plan.product_code),
  }, null, 2));
}

await main();
