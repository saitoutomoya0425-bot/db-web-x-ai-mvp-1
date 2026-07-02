import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { Video } from "@/types/database";

export const runtime = "nodejs";
export const maxDuration = 60;
type Insert = Omit<Video, "id" | "created_at" | "updated_at">;
type Raw = Record<string, unknown>;
type RowError = { row: number; product_code?: string; message: string };
const names: Record<string, string> = {
  "品番": "product_code", "タイトル": "title", "女優名": "actress_name", "女優名かな": "actress_name_kana", "女優名カナ": "actress_name_kana", "メーカー": "maker_name",
  "シリーズ": "series_name", "シリーズ名": "series_name", "レーベル": "label_name", "ジャンル": "genre",
  "収録時間": "duration", "発売日": "release_date", "サンプル画像": "sample_images",
  "サムネ画像url": "thumbnail_url", "動画url": "video_url", "アフィリエイトurl": "affiliate_url",
  "説明": "description", "人気度": "popularity", "お気に入り数": "favorite_count",
  "タグ": "tags" as keyof Insert,
};
const value = (input: unknown) => String(input ?? "").trim() || null;
const integer = (input: unknown, optional = false) => {
  const raw = value(input);
  if (!raw) return { value: optional ? null : 0, ok: true };
  const parsed = Number(raw);
  return { value: parsed, ok: /^\d+$/.test(raw) && Number.isSafeInteger(parsed) && parsed >= 0 };
};
const validUrl = (input: string | null) => {
  if (!input) return true;
  try { return ["http:", "https:"].includes(new URL(input).protocol); } catch { return false; }
};
function validate(input: Raw, row: number): { data?: Insert; tags?: string[]; actressKana?: string | null; error?: RowError } {
  const raw = Object.fromEntries(Object.entries(input).map(([key, item]) => {
    const normalized = key.replace(/^\uFEFF/, "").trim().toLowerCase();
    return [names[normalized] ?? normalized, item];
  })) as Raw;
  const code = value(raw.product_code)?.toUpperCase() ?? "";
  const title = value(raw.title) ?? "";
  const duration = integer(raw.duration, true);
  const popularity = integer(raw.popularity);
  const favorites = integer(raw.favorite_count);
  const release = value(raw.release_date);
  let samples: string[] = [];
  const sampleRaw = value(raw.sample_images);
  if (sampleRaw) {
    try { const parsed = JSON.parse(sampleRaw); samples = Array.isArray(parsed) ? parsed.map(String) : [sampleRaw]; }
    catch { samples = sampleRaw.split("|").map((item) => item.trim()).filter(Boolean); }
  }
  const fail = (message: string) => ({ error: { row, product_code: code || undefined, message } });
  if (!code) return fail("品番は必須です。");
  if (!title) return fail("タイトルは必須です。");
  if (release && !/^\d{4}-\d{2}-\d{2}$/.test(release)) return fail("発売日はYYYY-MM-DD形式です。");
  if (!duration.ok || !popularity.ok || !favorites.ok) return fail("数値項目は0以上の整数です。");
  const thumbnail = value(raw.thumbnail_url), video = value(raw.video_url), affiliate = value(raw.affiliate_url);
  const tags = (value(raw.tags) ?? "").split("|").map((tag) => tag.trim()).filter(Boolean).slice(0, 100);
  if (![thumbnail, video, affiliate, ...samples].every(validUrl)) return fail("URL形式が正しくありません。");
  return { tags, actressKana:value(raw.actress_name_kana), data: {
    product_code: code, title, actress_name: value(raw.actress_name), maker_name: value(raw.maker_name),
    series_name: value(raw.series_name), label_name: value(raw.label_name), genre: value(raw.genre),
    duration: duration.value, release_date: release, sample_images: samples, thumbnail_url: thumbnail,
    video_url: video, affiliate_url: affiliate, description: value(raw.description),
    popularity: popularity.value ?? 0, favorite_count: favorites.value ?? 0,
  } };
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.app_metadata?.role !== "admin") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json();
  if (body.action === "start") {
    const fingerprint = String(body.fingerprint ?? "").slice(0, 128);
    const existing = fingerprint ? await supabase.from("import_jobs").select("*").eq("user_id", user.id).eq("file_fingerprint", fingerprint).in("status", ["processing", "failed"]).order("updated_at", { ascending: false }).limit(1).maybeSingle() : null;
    if (existing && !existing.error && existing.data) {
      await supabase.from("import_jobs").update({ status: "processing", last_error: null }).eq("id", existing.data.id);
      return NextResponse.json({ jobId: existing.data.id, resumed: true, resumeOffset: existing.data.processed_count, imported: existing.data.imported_count, failed: existing.data.failed_count, duplicates: existing.data.duplicate_count, errors: existing.data.errors });
    }
    const created = await supabase.from("import_jobs").insert({ user_id: user.id, file_name: String(body.fileName ?? "import.csv").slice(0, 500), file_size: Number(body.fileSize ?? 0), file_fingerprint: fingerprint || null, status: "processing", processed_count: 0, imported_count: 0, failed_count: 0, duplicate_count: 0, errors: [] }).select("id").single();
    if (created.error) {
      if (["PGRST204", "PGRST205"].includes(created.error.code ?? "") || created.error.message.includes("import_jobs")) return NextResponse.json({ jobId: `stateless-${crypto.randomUUID()}`, resumed: false, resumeOffset: 0, imported: 0, failed: 0, duplicates: 0, errors: [] });
      return NextResponse.json({ error: created.error.message }, { status: 500 });
    }
    return NextResponse.json({ jobId: created.data.id, resumed: false, resumeOffset: 0, imported: 0, failed: 0, duplicates: 0, errors: [] });
  }
  const jobId = String(body.jobId ?? "");
  const stateless = jobId.startsWith("stateless-");
  const stored = stateless ? null : (await supabase.from("import_jobs").select("*").eq("id", jobId).eq("user_id", user.id).maybeSingle()).data;
  const job = stored ?? { processed_count: 0, imported_count: 0, failed_count: 0, duplicate_count: 0, errors: [] };
  if (!stateless && !stored) return NextResponse.json({ error: "Import job not found" }, { status: 404 });
  if (body.action === "complete" || body.action === "fail") {
    if (!stateless) await supabase.from("import_jobs").update(body.action === "complete" ? { status: "completed", total_count: Number(body.totalCount ?? job.processed_count), last_error: null } : { status: "failed", last_error: String(body.message ?? "Interrupted").slice(0, 2000) }).eq("id", jobId);
    return NextResponse.json({ processed: job.processed_count, imported: job.imported_count, failed: job.failed_count, duplicates: job.duplicate_count });
  }
  if (body.action !== "chunk" || !Array.isArray(body.rows) || body.rows.length > 2000) return NextResponse.json({ error: "Invalid chunk" }, { status: 400 });
  const offset = Number(body.rowOffset ?? 0);
  if (!stateless && offset < job.processed_count) return NextResponse.json({ alreadyProcessed: true, processed: 0, imported: 0, failed: 0, duplicates: 0, errors: [], cumulative: { processed: job.processed_count, imported: job.imported_count, failed: job.failed_count, duplicates: job.duplicate_count } });
  if (!stateless && offset !== job.processed_count) return NextResponse.json({ error: "Chunk offset mismatch", expectedOffset: job.processed_count }, { status: 409 });
  const errors: RowError[] = [], rows: { row: number; data: Insert; tags: string[]; actressKana:string|null }[] = [];
  (body.rows as Raw[]).forEach((raw, index) => { const checked = validate(raw, offset + index + 2); if (checked.error) errors.push(checked.error); if (checked.data) rows.push({ row: offset + index + 2, data: checked.data, tags: checked.tags ?? [], actressKana:checked.actressKana??null }); });
  const inserted = await supabase.from("videos").upsert(rows.map((row) => row.data), { onConflict: "product_code", ignoreDuplicates: true }).select("product_code");
  let imported = inserted.error ? 0 : inserted.data?.length ?? 0;
  let duplicates = inserted.error ? 0 : rows.length - imported;
  if (inserted.error) for (const row of rows) {
    const result = await supabase.from("videos").upsert(row.data, { onConflict: "product_code", ignoreDuplicates: true }).select("product_code");
    if (result.error) errors.push({ row: row.row, product_code: row.data.product_code, message: result.error.message });
    else if (result.data?.length) imported++;
    else duplicates++;
  }
  const actresses=[...new Map(rows.filter(row=>row.data.actress_name).map(row=>[row.data.actress_name!,{name:row.data.actress_name!,name_kana:row.actressKana}])).values()];
  const makers=[...new Set(rows.map(row=>row.data.maker_name).filter((name):name is string=>Boolean(name)))];
  await Promise.all([
    actresses.length?supabase.from("actresses").upsert(actresses,{onConflict:"name"}):Promise.resolve(),
    makers.length?supabase.from("makers").upsert(makers.map(name=>({name})),{onConflict:"name",ignoreDuplicates:true}):Promise.resolve(),
  ]);
  const aliases=actresses.filter(item=>item.name_kana&&item.name_kana!==item.name).map(item=>({entity_type:"actress",canonical_name:item.name,alias:item.name_kana!}));
  if(aliases.length)await supabase.from("entity_aliases").upsert(aliases,{onConflict:"entity_type,normalized_alias,canonical_name",ignoreDuplicates:true});
  const tagNames = [...new Set(rows.flatMap((row) => row.tags))];
  if (tagNames.length) {
    await supabase.from("tags").upsert(tagNames.map((name) => ({ name })), { onConflict: "name", ignoreDuplicates: true });
    const [{ data: videos }, { data: tags }] = await Promise.all([
      supabase.from("videos").select("id,product_code").in("product_code", rows.map((row) => row.data.product_code)),
      supabase.from("tags").select("id,name").in("name", tagNames),
    ]);
    const videoIds = new Map((videos ?? []).map((video) => [video.product_code, video.id]));
    const tagIds = new Map((tags ?? []).map((tag) => [tag.name, tag.id]));
    const links = rows.flatMap((row) => row.tags.flatMap((tag) => {
      const video_id = videoIds.get(row.data.product_code), tag_id = tagIds.get(tag);
      return video_id && tag_id ? [{ video_id, tag_id }] : [];
    }));
    if (links.length) await supabase.from("video_tags").upsert(links, { onConflict: "video_id,tag_id", ignoreDuplicates: true });
  }
  const cumulative = { processed: job.processed_count + body.rows.length, imported: job.imported_count + imported, failed: job.failed_count + errors.length, duplicates: job.duplicate_count + duplicates };
  if (!stateless) {
    if (errors.length) await supabase.from("import_errors").insert(errors.map((error) => ({ job_id: jobId, row_number: error.row, product_code: error.product_code ?? null, message: error.message, raw_data: body.rows[error.row - offset - 2] ?? null })));
    await supabase.from("import_jobs").update({ processed_count: cumulative.processed, imported_count: cumulative.imported, failed_count: cumulative.failed, duplicate_count: cumulative.duplicates, errors: [...(Array.isArray(job.errors) ? job.errors : []), ...errors].slice(0, 1000) }).eq("id", jobId);
  }
  return NextResponse.json({ processed: body.rows.length, imported, failed: errors.length, duplicates, errors, cumulative });
}
