import { createClient } from "@/lib/supabase/server";
import { getPopularWorksPeriod, toWorkDetails } from "@/lib/queries/public-works";
import type { WorkDetail } from "@/types/database";
import { weightedRecommendationProvider } from "@/lib/recommendations/provider";

export type RankingType = "actress" | "maker" | "series";
export type MetricRank = { key: string; rank: number; score: number; searches: number; clicks: number; workCount: number };

export async function getEntityRanking(type: RankingType, period = "week", limit = 50): Promise<MetricRank[]> {
  const supabase = await createClient();
  const { data } = await supabase.from("discovery_metrics").select("entity_key,rank,score,searches,clicks,metadata")
    .eq("entity_type", type).eq("period", period).order("rank").limit(limit);
  return (data ?? []).map((row, index) => ({
    key: row.entity_key, rank: row.rank ?? index + 1, score: Number(row.score) || 0,
    searches: Number(row.searches) || 0, clicks: Number(row.clicks) || 0,
    workCount: Number((row.metadata as { work_count?: number } | null)?.work_count) || 0,
  }));
}

export async function getTrendingWorks(limit = 12) {
  return getPopularWorksPeriod(limit, 0, 7);
}

export async function getRecommendedWorks(limit = 12): Promise<WorkDetail[]> {
  const supabase = await createClient();
  const { data } = await supabase.from("videos").select("*").eq("is_published", true)
    .order("popularity", { ascending: false }).order("favorite_count", { ascending: false }).limit(limit);
  return weightedRecommendationProvider.recommend(toWorkDetails(data), {}, limit);
}

export async function getTagWorks(name: string, limit = 24, offset = 0) {
  const supabase = await createClient();
  const { data: tag } = await supabase.from("tags").select("id,name").eq("name", name).maybeSingle();
  if (!tag) return [];
  const { data: links } = await supabase.from("video_tags").select("video_id").eq("tag_id", tag.id).range(offset, offset + limit - 1);
  const ids = (links ?? []).map((link) => link.video_id);
  if (!ids.length) return [];
  const { data } = await supabase.from("videos").select("*").eq("is_published", true).in("id", ids).order("popularity", { ascending: false });
  return toWorkDetails(data);
}

export async function getPopularTags(limit = 30) {
  const supabase = await createClient();
  const { data: published } = await supabase.from("videos").select("id").eq("is_published", true).limit(10_000);
  const ids = (published ?? []).map((item) => item.id);
  if (!ids.length) return [];
  const { data: links } = await supabase.from("video_tags").select("tag_id").in("video_id", ids);
  const tagIds = [...new Set((links ?? []).map((item) => item.tag_id))];
  if (!tagIds.length) return [];
  const { data } = await supabase.from("tags").select("id,name").in("id", tagIds).order("name").limit(limit);
  return data ?? [];
}
