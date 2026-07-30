import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { Video } from "@/types/database";

export const runtime = "nodejs";
export const maxDuration = 60;

type WritableVideo = Omit<Video, "id" | "created_at" | "updated_at">;
type VideoPatch = Partial<WritableVideo> & Pick<WritableVideo, "product_code">;
type Raw = Record<string, unknown>;
type RowError = { row: number; product_code?: string; message: string };
type CheckedRow = {
  row: number;
  patch: VideoPatch;
  tags: string[];
  genres: string[];
  tagsSupplied: boolean;
  genresSupplied: boolean;
  actressKana: string | null;
  clearFields: Set<string>;
};

const names: Record<string, string> = {
  "品番": "product_code", "タイトル": "title", "女優名": "actress_name", "女優名かな": "actress_name_kana", "女優名カナ": "actress_name_kana",
  "メーカー": "maker_name", "シリーズ": "series_name", "シリーズ名": "series_name", "レーベル": "label_name",
  "ジャンル": "genre", "収録時間": "duration", "発売日": "release_date", "サンプル画像": "sample_images",
  "カード画像url": "card_thumbnail_url", "サムネ画像url": "thumbnail_url", "動画url": "video_url", "アフィリエイトurl": "affiliate_url",
  "説明": "description", "人気度": "popularity", "お気に入り数": "favorite_count", "タグ": "tags",
  "削除項目": "clear_fields",
};
const clearable = new Set([
  "actress_name", "maker_name", "series_name", "label_name", "genre", "duration", "release_date",
  "sample_images", "card_thumbnail_url", "thumbnail_url", "video_url", "affiliate_url", "description", "popularity", "favorite_count",
  "tags",
]);
const value = (input: unknown) => String(input ?? "").trim() || null;
const validUrl = (input: string | null) => {
  if (!input) return true;
  try { return ["http:", "https:"].includes(new URL(input).protocol); } catch { return false; }
};
const splitList = (input: unknown) => (value(input) ?? "").split("|").map((item) => item.trim()).filter(Boolean);
const normalizeKeys = (input: Raw) => Object.fromEntries(Object.entries(input).map(([key, item]) => {
  const normalized = key.replace(/^\uFEFF/, "").trim().toLowerCase();
  return [names[normalized] ?? normalized, item];
})) as Raw;

function validate(input: Raw, row: number): { data?: CheckedRow; error?: RowError } {
  const raw = normalizeKeys(input);
  const code = value(raw.product_code)?.toUpperCase() ?? "";
  const fail = (message: string) => ({ error: { row, product_code: code || undefined, message } });
  if (!code) return fail("品番は必須です。");

  const patch: VideoPatch = { product_code: code };
  const assignText = (field: keyof WritableVideo) => {
    const item = value(raw[field]);
    if (item) Object.assign(patch, { [field]: item });
  };
  (["title", "actress_name", "maker_name", "series_name", "label_name", "release_date", "card_thumbnail_url", "thumbnail_url", "video_url", "affiliate_url", "description"] as const).forEach(assignText);

  const release = value(raw.release_date);
  if (release && !/^\d{4}-\d{2}-\d{2}$/.test(release)) return fail("発売日はYYYY-MM-DD形式です。");
  for (const field of ["duration", "popularity", "favorite_count"] as const) {
    const item = value(raw[field]);
    if (!item) continue;
    const parsed = Number(item);
    if (!/^\d+$/.test(item) || !Number.isSafeInteger(parsed) || parsed < 0) return fail("数値項目は0以上の整数です。");
    patch[field] = parsed;
  }

  let samples: string[] = [];
  const sampleRaw = value(raw.sample_images);
  if (sampleRaw) {
    try {
      const parsed: unknown = JSON.parse(sampleRaw);
      samples = Array.isArray(parsed) ? parsed.map(String).map((item) => item.trim()).filter(Boolean) : [sampleRaw];
    } catch {
      samples = splitList(sampleRaw);
    }
    patch.sample_images = samples;
  }
  const genres = splitList(raw.genre).slice(0, 100);
  if (genres.length) patch.genre = genres[0];
  const tags = splitList(raw.tags).slice(0, 100);
  const clearFields = new Set(splitList(raw.clear_fields).map((field) => names[field.toLowerCase()] ?? field.toLowerCase()));
  for (const field of clearFields) if (!clearable.has(field)) return fail(`削除項目「${field}」は指定できません。`);

  const urls = [value(raw.card_thumbnail_url), value(raw.thumbnail_url), value(raw.video_url), value(raw.affiliate_url), ...samples];
  if (!urls.every(validUrl)) return fail("URL形式が正しくありません。");
  return {
    data: {
      row, patch, tags, genres, actressKana: value(raw.actress_name_kana), clearFields,
      tagsSupplied: tags.length > 0 || clearFields.has("tags"),
      genresSupplied: genres.length > 0 || clearFields.has("genre"),
    },
  };
}

function clearedValue(field: string) {
  if (field === "sample_images") return [];
  if (field === "popularity" || field === "favorite_count") return 0;
  return null;
}
function newVideo(patch: VideoPatch): WritableVideo | null {
  if (!patch.title) return null;
  return {
    product_code: patch.product_code,
    title: patch.title,
    actress_id: null, maker_id: null, series_id: null,
    actress_name: patch.actress_name ?? null, maker_name: patch.maker_name ?? null,
    series_name: patch.series_name ?? null, label_name: patch.label_name ?? null, genre: patch.genre ?? null,
    duration: patch.duration ?? null, release_date: patch.release_date ?? null,
    sample_images: patch.sample_images ?? [], card_thumbnail_url: patch.card_thumbnail_url ?? null,
    thumbnail_url: patch.thumbnail_url ?? null,
    video_url: patch.video_url ?? null, official_url: patch.official_url ?? null,
    affiliate_url: patch.affiliate_url ?? null, source_name: patch.source_name ?? null,
    external_product_id: patch.external_product_id ?? null, source_checked_at: patch.source_checked_at ?? null,
    description: patch.description ?? null, popularity: patch.popularity ?? 0, favorite_count: patch.favorite_count ?? 0,
    is_published: false, content_category: "commercial_av",
  };
}
function changedFields(before: Video, after: WritableVideo) {
  return Object.keys(after).filter((key) => JSON.stringify(before[key as keyof Video]) !== JSON.stringify(after[key as keyof WritableVideo]));
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.app_metadata?.role !== "admin") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const catalog = createAdminClient();
  const body = await request.json();

  if (body.action === "start") {
    const fingerprint = String(body.fingerprint ?? "").slice(0, 128);
    const existing = fingerprint ? await supabase.from("import_jobs").select("*").eq("user_id", user.id).eq("file_fingerprint", fingerprint).in("status", ["processing", "failed"]).order("updated_at", { ascending: false }).limit(1).maybeSingle() : null;
    if (existing && !existing.error && existing.data) {
      await supabase.from("import_jobs").update({ status: "processing", last_error: null }).eq("id", existing.data.id);
      return NextResponse.json({ jobId: existing.data.id, resumed: true, resumeOffset: existing.data.processed_count, imported: existing.data.imported_count, updated: existing.data.updated_count ?? 0, failed: existing.data.failed_count, duplicates: existing.data.duplicate_count, errors: existing.data.errors });
    }
    const created = await supabase.from("import_jobs").insert({ user_id: user.id, file_name: String(body.fileName ?? "import.csv").slice(0, 500), file_size: Number(body.fileSize ?? 0), file_fingerprint: fingerprint || null, status: "processing", processed_count: 0, imported_count: 0, updated_count: 0, failed_count: 0, duplicate_count: 0, errors: [] }).select("id").single();
    if (created.error) {
      if (["PGRST204", "PGRST205"].includes(created.error.code ?? "") || created.error.message.includes("import_jobs")) return NextResponse.json({ jobId: `stateless-${crypto.randomUUID()}`, resumed: false, resumeOffset: 0, imported: 0, updated: 0, failed: 0, duplicates: 0, errors: [] });
      return NextResponse.json({ error: created.error.message }, { status: 500 });
    }
    return NextResponse.json({ jobId: created.data.id, resumed: false, resumeOffset: 0, imported: 0, updated: 0, failed: 0, duplicates: 0, errors: [] });
  }

  const jobId = String(body.jobId ?? "");
  const stateless = jobId.startsWith("stateless-");
  const stored = stateless ? null : (await supabase.from("import_jobs").select("*").eq("id", jobId).eq("user_id", user.id).maybeSingle()).data;
  const job = stored ?? { processed_count: 0, imported_count: 0, updated_count: 0, failed_count: 0, duplicate_count: 0, errors: [] };
  if (!stateless && !stored) return NextResponse.json({ error: "Import job not found" }, { status: 404 });
  if (body.action === "complete" || body.action === "fail") {
    if (!stateless) await supabase.from("import_jobs").update(body.action === "complete" ? { status: "completed", total_count: Number(body.totalCount ?? job.processed_count), last_error: null } : { status: "failed", last_error: String(body.message ?? "Interrupted").slice(0, 2000) }).eq("id", jobId);
    return NextResponse.json({ processed: job.processed_count, imported: job.imported_count, updated: job.updated_count, failed: job.failed_count, duplicates: job.duplicate_count });
  }
  if (body.action !== "chunk" || !Array.isArray(body.rows) || body.rows.length > 2000) return NextResponse.json({ error: "Invalid chunk" }, { status: 400 });

  const offset = Number(body.rowOffset ?? 0);
  if (!stateless && offset < job.processed_count) return NextResponse.json({ alreadyProcessed: true, processed: 0, imported: 0, updated: 0, failed: 0, duplicates: 0, errors: [], cumulative: { processed: job.processed_count, imported: job.imported_count, updated: job.updated_count, failed: job.failed_count, duplicates: job.duplicate_count } });
  if (!stateless && offset !== job.processed_count) return NextResponse.json({ error: "Chunk offset mismatch", expectedOffset: job.processed_count }, { status: 409 });

  const errors: RowError[] = [];
  const checked: CheckedRow[] = [];
  (body.rows as Raw[]).forEach((raw, index) => {
    const result = validate(raw, offset + index + 2);
    if (result.error) errors.push(result.error);
    if (result.data) checked.push(result.data);
  });
  const codes = checked.map((row) => row.patch.product_code);
  const { data: existingData, error: existingError } = codes.length
    ? await catalog.from("videos").select("*").in("product_code", codes)
    : { data: [], error: null };
  if (existingError) return NextResponse.json({ error: existingError.message }, { status: 500 });
  const existingByCode = new Map((existingData ?? []).map((video) => [video.product_code, video]));
  const updateExisting = body.duplicateMode === "update";
  const relationMode = body.relationMode === "replace" ? "replace" : "merge";
  const writable: { row: CheckedRow; data: WritableVideo; before: Video | null }[] = [];
  let duplicates = 0;

  for (const row of checked) {
    const before = existingByCode.get(row.patch.product_code) ?? null;
    if (before && !updateExisting) { duplicates++; continue; }
    const data = before
      ? ({ ...before, ...row.patch } as WritableVideo)
      : newVideo(row.patch);
    if (!data) {
      errors.push({ row: row.row, product_code: row.patch.product_code, message: "新規作品ではタイトルが必須です。" });
      continue;
    }
    for (const field of row.clearFields) {
      if (field === "tags") continue;
      Object.assign(data, { [field]: clearedValue(field) });
    }
    writable.push({ row, data, before });
  }

  const succeeded = new Set<string>();
  if (writable.length) {
    const { data, error } = await catalog.from("videos").upsert(writable.map((item) => item.data), { onConflict: "product_code" }).select("product_code");
    if (!error) (data ?? []).forEach((item) => succeeded.add(item.product_code));
    else {
      for (const item of writable) {
        const result = await catalog.from("videos").upsert(item.data, { onConflict: "product_code" }).select("product_code");
        if (result.error) errors.push({ row: item.row.row, product_code: item.data.product_code, message: result.error.message });
        else succeeded.add(item.data.product_code);
      }
    }
  }
  const saved = writable.filter((item) => succeeded.has(item.data.product_code));
  const imported = saved.filter((item) => !item.before).length;
  const updated = saved.filter((item) => item.before).length;

  const actresses = [...new Map(saved.filter((item) => item.data.actress_name).map((item) => [item.data.actress_name!, { name: item.data.actress_name!, name_kana: item.row.actressKana }])).values()];
  const makerNames = [...new Set(saved.map((item) => item.data.maker_name).filter((name): name is string => Boolean(name)))];
  if (actresses.length) {
    const { error } = await catalog.from("actresses").upsert(actresses, { onConflict: "name" });
    if (error) errors.push({ row: offset + 2, message: `女優同期: ${error.message}` });
  }
  if (makerNames.length) {
    const { error } = await catalog.from("makers").upsert(makerNames.map((name) => ({ name })), { onConflict: "name", ignoreDuplicates: true });
    if (error) errors.push({ row: offset + 2, message: `メーカー同期: ${error.message}` });
  }
  const aliases = actresses.filter((item) => item.name_kana && item.name_kana !== item.name).map((item) => ({ entity_type: "actress", canonical_name: item.name, alias: item.name_kana! }));
  if (aliases.length) {
    const { error } = await catalog.from("entity_aliases").upsert(aliases, { onConflict: "entity_type,normalized_alias,canonical_name", ignoreDuplicates: true });
    if (error) errors.push({ row: offset + 2, message: `女優別名同期: ${error.message}` });
  }

  const [{ data: videos }, { data: actressRows }, { data: makerRows }] = await Promise.all([
    saved.length ? catalog.from("videos").select("id,product_code").in("product_code", saved.map((item) => item.data.product_code)) : Promise.resolve({ data: [] }),
    actresses.length ? catalog.from("actresses").select("id,name").in("name", actresses.map((item) => item.name)) : Promise.resolve({ data: [] }),
    makerNames.length ? catalog.from("makers").select("id,name").in("name", makerNames) : Promise.resolve({ data: [] }),
  ]);
  const videoIds = new Map((videos ?? []).map((item) => [item.product_code, item.id]));
  const actressIds = new Map((actressRows ?? []).map((item) => [item.name, item.id]));
  const makerIds = new Map((makerRows ?? []).map((item) => [item.name, item.id]));

  const seriesItems = [...new Map(saved.filter((item) => item.data.series_name).map((item) => [item.data.series_name!, {
    name: item.data.series_name!, maker_id: item.data.maker_name ? makerIds.get(item.data.maker_name) ?? null : null,
  }])).values()];
  if (seriesItems.length) {
    const { error } = await catalog.from("series").upsert(seriesItems, { onConflict: "name" });
    if (error) errors.push({ row: offset + 2, message: `シリーズ同期: ${error.message}` });
  }
  const { data: seriesRows } = seriesItems.length
    ? await catalog.from("series").select("id,name").in("name", seriesItems.map((item) => item.name))
    : { data: [] };
  const seriesIds = new Map((seriesRows ?? []).map((item) => [item.name, item.id]));
  for (const item of saved) {
    const videoId = videoIds.get(item.data.product_code);
    if (!videoId) continue;
    const { error } = await catalog.from("videos").update({
      actress_id: item.data.actress_name ? actressIds.get(item.data.actress_name) ?? null : null,
      maker_id: item.data.maker_name ? makerIds.get(item.data.maker_name) ?? null : null,
      series_id: item.data.series_name ? seriesIds.get(item.data.series_name) ?? null : null,
    }).eq("id", videoId);
    if (error) errors.push({ row: item.row.row, product_code: item.data.product_code, message: `補助ID同期: ${error.message}` });
  }

  const tagNames = [...new Set(saved.flatMap((item) => item.row.tags))];
  if (tagNames.length) await catalog.from("tags").upsert(tagNames.map((name) => ({ name })), { onConflict: "name", ignoreDuplicates: true });
  const { data: tagRows } = tagNames.length ? await catalog.from("tags").select("id,name").in("name", tagNames) : { data: [] };
  const tagIds = new Map((tagRows ?? []).map((item) => [item.name, item.id]));
  const genreNames = [...new Set(saved.flatMap((item) => item.row.genres))];
  if (genreNames.length) await catalog.from("genres").upsert(genreNames.map((name) => ({ name })), { onConflict: "name", ignoreDuplicates: true });
  const { data: genreRows } = genreNames.length ? await catalog.from("genres").select("id,name").in("name", genreNames) : { data: [] };
  const genreIds = new Map((genreRows ?? []).map((item) => [item.name, item.id]));

  for (const item of saved) {
    const videoId = videoIds.get(item.data.product_code);
    if (!videoId) continue;
    if (item.row.tagsSupplied) {
      if (relationMode === "replace" || item.row.clearFields.has("tags")) await catalog.from("video_tags").delete().eq("video_id", videoId);
      const links = item.row.tags.flatMap((name) => tagIds.get(name) ? [{ video_id: videoId, tag_id: tagIds.get(name)! }] : []);
      if (links.length) {
        const { error } = await catalog.from("video_tags").upsert(links, { onConflict: "video_id,tag_id", ignoreDuplicates: true });
        if (error) errors.push({ row: item.row.row, product_code: item.data.product_code, message: `タグ関連同期: ${error.message}` });
      }
    }
    if (item.row.genresSupplied) {
      if (relationMode === "replace" || item.row.clearFields.has("genre")) await catalog.from("video_genres").delete().eq("video_id", videoId);
      const links = item.row.genres.flatMap((name) => genreIds.get(name) ? [{ video_id: videoId, genre_id: genreIds.get(name)! }] : []);
      if (links.length) {
        const { error } = await catalog.from("video_genres").upsert(links, { onConflict: "video_id,genre_id", ignoreDuplicates: true });
        if (error) errors.push({ row: item.row.row, product_code: item.data.product_code, message: `ジャンル関連同期: ${error.message}` });
      }
    }
    if (item.before) {
      const fields = changedFields(item.before, item.data);
      if (fields.length) await catalog.from("video_change_logs").insert({
        video_id: videoId, changed_fields: fields, before_data: item.before, after_data: item.data, change_source: "csv",
      });
    }
  }

  const cumulative = { processed: job.processed_count + body.rows.length, imported: job.imported_count + imported, updated: job.updated_count + updated, failed: job.failed_count + errors.length, duplicates: job.duplicate_count + duplicates };
  if (!stateless) {
    if (errors.length) await supabase.from("import_errors").insert(errors.map((error) => ({ job_id: jobId, row_number: error.row, product_code: error.product_code ?? null, message: error.message, raw_data: body.rows[error.row - offset - 2] ?? null })));
    await supabase.from("import_jobs").update({ processed_count: cumulative.processed, imported_count: cumulative.imported, updated_count: cumulative.updated, failed_count: cumulative.failed, duplicate_count: cumulative.duplicates, errors: [...(Array.isArray(job.errors) ? job.errors : []), ...errors].slice(0, 1000) }).eq("id", jobId);
  }
  return NextResponse.json({ processed: body.rows.length, imported, updated, failed: errors.length, duplicates, errors, cumulative });
}
