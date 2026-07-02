import { createClient } from "@/lib/supabase/server";
import type { PopularWork, WorkDetail } from "@/types/database";

export function normalizeCode(code: string) {
  try { return decodeURIComponent(code).trim().toUpperCase(); }
  catch { return code.trim().toUpperCase(); }
}
export function normalizeProductCode(code: string) {
  return normalizeCode(code).replace(/[^A-Z0-9]/g, "");
}

function text(value: unknown) {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}
function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}
function imageUrl(value: unknown) {
  const url = text(value);
  if (!url) return null;
  if (url.startsWith("/")) return url;
  try { return ["http:", "https:"].includes(new URL(url).protocol) ? url : null; } catch { return null; }
}
export function toWorkDetail(input: unknown): WorkDetail | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const video = input as Record<string, unknown>;
  const productCode = text(video.product_code);
  const title = text(video.title);
  if (!productCode || !title) return null;
  const id = text(video.id) ?? productCode;
  const actressName = text(video.actress_name);
  const makerName = text(video.maker_name);
  return {
    id,
    product_code: productCode,
    title,
    actress_id: actressName,
    maker_id: makerName,
    release_date: text(video.release_date),
    thumbnail_url: imageUrl(video.thumbnail_url),
    sample_url: imageUrl(video.video_url),
    affiliate_url: imageUrl(video.affiliate_url),
    description: text(video.description),
    series_name: text(video.series_name),
    label_name: text(video.label_name),
    genre: text(video.genre),
    duration: numberValue(video.duration),
    sample_images: Array.isArray(video.sample_images)
      ? video.sample_images.map(imageUrl).filter((url): url is string => url !== null)
      : [],
    popularity: numberValue(video.popularity) ?? 0,
    favorite_count: numberValue(video.favorite_count) ?? 0,
    created_at: text(video.created_at) ?? new Date(0).toISOString(),
    updated_at: text(video.updated_at) ?? text(video.created_at) ?? new Date(0).toISOString(),
    actresses: actressName
      ? { id: actressName, name: actressName, name_kana: null, profile_url: null }
      : null,
    makers: makerName
      ? { id: makerName, name: makerName, official_url: null }
      : null,
    work_tags: [],
  };
}
export function toWorkDetails(input: unknown): WorkDetail[] {
  if (!Array.isArray(input)) return [];
  return input.map(toWorkDetail).filter((work): work is WorkDetail => work !== null);
}

export type SearchSort = "popular" | "new" | "release";
export type SearchFilters = { actress?: string; maker?: string; series?: string };
export async function searchVideos(query: string, limit = 24, offset = 0, sort: SearchSort = "popular", filters: SearchFilters = {}) {
  const normalized = typeof query === "string" ? query.trim() : "";
  const clean = (value?: string) => value?.replace(/[,%()]/g, " ").trim().slice(0, 100) ?? "";
  const actress = clean(filters.actress);
  const maker = clean(filters.maker);
  const series = clean(filters.series);
  if (!normalized && !actress && !maker && !series) return [];
  try {
    const supabase = await createClient();
    if (actress || maker || series) {
      let filtered = supabase.from("videos").select("*");
      const safeQuery = clean(normalized);
      if (safeQuery) filtered = filtered.or(`product_code.ilike.%${safeQuery}%,title.ilike.%${safeQuery}%`);
      if (actress) filtered = filtered.ilike("actress_name", `%${actress}%`);
      if (maker) filtered = filtered.ilike("maker_name", `%${maker}%`);
      if (series) filtered = filtered.ilike("series_name", `%${series}%`);
      if (sort === "new") filtered = filtered.order("created_at", { ascending: false });
      else if (sort === "release") filtered = filtered.order("release_date", { ascending: false, nullsFirst: false });
      else filtered = filtered.order("popularity", { ascending: false }).order("created_at", { ascending: false });
      const { data, error } = await filtered.range(offset, offset + Math.min(Math.max(limit, 1), 100) - 1);
      return error ? [] : toWorkDetails(data);
    }
    const { data, error } = await supabase.rpc("search_videos", {
      search_query: normalized,
      sort_by: sort,
      result_limit: Math.min(Math.max(limit, 1), 100),
      result_offset: Math.max(offset, 0),
    });
    if (error) {
      const safeQuery = normalized.replace(/[,%()]/g, " ").trim();
      if (!safeQuery) return [];
      const compactCode = safeQuery.replace(/[^a-zA-Z0-9]/g, "");
      const codeMatch = compactCode.match(/^([a-zA-Z]+)(\d+)$/);
      const hyphenCode = codeMatch ? `${codeMatch[1]}-${codeMatch[2]}` : safeQuery;
      let fallbackQuery = supabase.from("videos").select("*")
        .or(`product_code.ilike.%${safeQuery}%,product_code.ilike.%${hyphenCode}%,title.ilike.%${safeQuery}%,actress_name.ilike.%${safeQuery}%,maker_name.ilike.%${safeQuery}%,series_name.ilike.%${safeQuery}%`);
      if (sort === "new") fallbackQuery = fallbackQuery.order("created_at", { ascending: false });
      else if (sort === "release") fallbackQuery = fallbackQuery.order("release_date", { ascending: false, nullsFirst: false });
      else fallbackQuery = fallbackQuery.order("popularity", { ascending: false }).order("created_at", { ascending: false });
      const fallback = await fallbackQuery.range(
        Math.max(offset, 0),
        Math.max(offset, 0) + Math.min(Math.max(limit, 1), 100) - 1,
      );
      if (fallback.error) {
        console.warn("Search is temporarily unavailable:", fallback.error.message);
        return [];
      }
      return toWorkDetails(fallback.data);
    }
    return toWorkDetails(data);
  } catch (error) {
    console.error("searchVideos failed:", error);
    return [];
  }
}

export async function getWorkByCode(code: string) {
  const supabase = await createClient();
  const normalized = normalizeCode(code).replace(/[^A-Z0-9 -]/g, "");
  const compact = normalizeProductCode(code);
  const match = compact.match(/^([A-Z]+)(\d+)$/);
  const hyphenated = match ? `${match[1]}-${match[2]}` : normalized;
  const { data, error } = await supabase
    .from("videos")
    .select("*")
    .or(`product_code.ilike.${normalized},product_code.ilike.${hyphenated}`)
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("getWorkByCode failed:", error.message);
    return null;
  }
  if (data) {
    const work = toWorkDetail(data);
    if (!work) return null;
    const { data: links } = await supabase.from("video_tags").select("tag_id").eq("video_id", work.id);
    const tagIds = (links ?? []).map((link) => link.tag_id);
    if (tagIds.length) {
      const { data: tags } = await supabase.from("tags").select("id,name").in("id", tagIds);
      work.work_tags = (tags ?? []).map((tag) => ({ tags: tag }));
    }
    return work;
  }
  const candidates = await searchVideos(code, 10);
  return candidates.find((work) => normalizeProductCode(work.product_code) === compact) ?? null;
}

export async function getRelatedWorks(work: WorkDetail, limit = 8) {
  const supabase = await createClient();
  let actressWorks: WorkDetail[] = [];
  let makerWorks: WorkDetail[] = [];
  let seriesWorks: WorkDetail[] = [];
  if (work.actresses?.name) {
    const { data } = await supabase.from("videos").select("*").eq("actress_name", work.actresses.name).neq("id", work.id).order("popularity", { ascending: false }).limit(limit);
    actressWorks = toWorkDetails(data);
  }
  if (work.makers?.name) {
    const { data } = await supabase.from("videos").select("*").eq("maker_name", work.makers.name).neq("id", work.id).order("popularity", { ascending: false }).limit(limit);
    makerWorks = toWorkDetails(data);
  }
  if (work.series_name) {
    const { data } = await supabase.from("videos").select("*").eq("series_name", work.series_name).neq("id", work.id).order("popularity", { ascending: false }).limit(limit);
    seriesWorks = toWorkDetails(data);
  }
  let relatedQuery = supabase.from("videos").select("*").neq("id", work.id);
  if (work.genre) relatedQuery = relatedQuery.eq("genre", work.genre);
  const { data: relatedData } = await relatedQuery.order("popularity", { ascending: false }).order("created_at", { ascending: false }).limit(limit);
  return { actressWorks, makerWorks, seriesWorks, relatedWorks: toWorkDetails(relatedData) };
}

export async function getPopularWorks(limit = 12) {
  const supabase = await createClient();
  const { data: ranks } = await supabase.rpc("get_popular_works", { result_limit: limit });
  if (ranks?.length) {
    const { data } = await supabase.from("videos").select("*").in("product_code", ranks.map((rank) => rank.product_code));
    const videos = toWorkDetails(data);
    const byCode = new Map(videos.map((video) => [video.product_code.toUpperCase(), video]));
    return ranks.flatMap((rank) => {
      const video = byCode.get(rank.product_code);
      return video ? [{ ...video, search_count: Number(rank.search_count) || 0 }] : [];
    });
  }
  const { data } = await supabase.from("videos").select("*").order("created_at", { ascending: false }).limit(limit);
  return toWorkDetails(data).map((video) => ({ ...video, search_count: 0 })) as PopularWork[];
}

export async function getPopularWorksPeriod(limit = 40, offset = 0, days: number | null = null) {
  const supabase = await createClient();
  const { data: ranks, error } = await supabase.rpc("get_popular_works_period", {
    period_days: days,
    result_limit: limit,
    result_offset: offset,
  });
  if (error || !ranks?.length) return offset === 0 ? getPopularWorks(limit) : [];
  const { data } = await supabase.from("videos").select("*").in("product_code", ranks.map((rank) => rank.product_code));
  const byCode = new Map(toWorkDetails(data).map((video) => [video.product_code.toUpperCase(), video]));
  return ranks.flatMap((rank) => {
    const video = byCode.get(rank.product_code.toUpperCase());
    return video ? [{ ...video, search_count: Number(rank.search_count) || 0 }] : [];
  });
}

export async function getNewestWorks(limit = 8) {
  try {
    const supabase = await createClient();
    const { data } = await supabase.from("videos").select("*").order("created_at", { ascending: false }).limit(limit);
    return toWorkDetails(data);
  } catch {
    return [];
  }
}

export async function getActressRanking(limit = 8) {
  const popular = await getPopularWorks(100);
  const counts = new Map<string, { actress: NonNullable<WorkDetail["actresses"]>; count: number }>();
  for (const work of popular) {
    if (!work.actresses) continue;
    const current = counts.get(work.actresses.name);
    counts.set(work.actresses.name, { actress: work.actresses, count: (current?.count ?? 0) + Math.max(work.search_count, 1) });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}
