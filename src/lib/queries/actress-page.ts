import { createClient } from "@/lib/supabase/server";
import { toWorkDetails } from "@/lib/queries/public-works";
import type { WorkDetail } from "@/types/database";

export type ActressSort = "popular" | "release" | "maker";
export type ActressLink = { name: string; workCount: number; popularity: number };
export type ActressPageData = {
  name: string;
  profileUrl: string | null;
  works: WorkDetail[];
  total: number;
  workCount: number;
  makerCount: number;
  sameMakerActresses: ActressLink[];
  relatedActresses: ActressLink[];
};

function links(input: unknown): ActressLink[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const value = row as Record<string, unknown>;
    const name = typeof value.actress_name === "string" ? value.actress_name.trim() : "";
    return name ? [{ name, workCount: Number(value.work_count) || 0, popularity: Number(value.popularity) || 0 }] : [];
  });
}

function aggregate(rows: { actress_name: string | null; popularity: number }[], excluded: string) {
  const values = new Map<string, ActressLink>();
  for (const row of rows) {
    if (!row.actress_name || row.actress_name === excluded) continue;
    const current = values.get(row.actress_name);
    values.set(row.actress_name, {
      name: row.actress_name,
      workCount: (current?.workCount ?? 0) + 1,
      popularity: (current?.popularity ?? 0) + (row.popularity ?? 0),
    });
  }
  return [...values.values()].sort((a, b) => b.popularity - a.popularity || b.workCount - a.workCount).slice(0, 8);
}

export async function getActressPageData(
  name: string,
  options: { query: string; sort: ActressSort; page: number; pageSize: number },
): Promise<ActressPageData> {
  const supabase = await createClient();
  const offset = (options.page - 1) * options.pageSize;
  const [worksResult, countResult, statsResult, sameMakerResult, relatedResult, profileResult] = await Promise.all([
    supabase.rpc("get_actress_works", {
      target_actress: name, search_query: options.query, sort_by: options.sort,
      result_limit: options.pageSize, result_offset: offset,
    }),
    supabase.rpc("count_actress_works", { target_actress: name, search_query: options.query }),
    supabase.rpc("get_actress_stats", { target_actress: name }),
    supabase.rpc("get_same_maker_actresses", { target_actress: name, result_limit: 8 }),
    supabase.rpc("get_related_actresses", { target_actress: name, result_limit: 8 }),
    supabase.from("actresses").select("profile_url").eq("name", name).maybeSingle(),
  ]);

  if (!worksResult.error && !countResult.error) {
    const stats = statsResult.data?.[0];
    return {
      name,
      profileUrl: profileResult.data?.profile_url ?? null,
      works: toWorkDetails(worksResult.data),
      total: Number(countResult.data) || 0,
      workCount: Number(stats?.work_count) || Number(countResult.data) || 0,
      makerCount: Number(stats?.maker_count) || 0,
      sameMakerActresses: links(sameMakerResult.data),
      relatedActresses: links(relatedResult.data),
    };
  }

  const safeQuery = options.query.replace(/[,%()]/g, " ").trim();
  let workQuery = supabase.from("videos").select("*").eq("actress_name", name);
  if (safeQuery) workQuery = workQuery.or(`product_code.ilike.%${safeQuery}%,title.ilike.%${safeQuery}%,maker_name.ilike.%${safeQuery}%,series_name.ilike.%${safeQuery}%`);
  if (options.sort === "release") workQuery = workQuery.order("release_date", { ascending: false, nullsFirst: false });
  else if (options.sort === "maker") workQuery = workQuery.order("maker_name", { ascending: true });
  else workQuery = workQuery.order("popularity", { ascending: false });

  let totalQuery = supabase.from("videos").select("id", { count: "exact", head: true }).eq("actress_name", name);
  if (safeQuery) totalQuery = totalQuery.or(`product_code.ilike.%${safeQuery}%,title.ilike.%${safeQuery}%,maker_name.ilike.%${safeQuery}%,series_name.ilike.%${safeQuery}%`);
  const [fallbackWorks, fallbackCount, allOwnWorks] = await Promise.all([
    workQuery.range(offset, offset + options.pageSize - 1),
    totalQuery,
    supabase.from("videos").select("maker_name,genre").eq("actress_name", name).limit(10_000),
  ]);
  const makers = [...new Set((allOwnWorks.data ?? []).map((row) => row.maker_name).filter((value): value is string => Boolean(value)))];
  const genres = [...new Set((allOwnWorks.data ?? []).map((row) => row.genre).filter((value): value is string => Boolean(value)))];
  const [makerRows, genreRows] = await Promise.all([
    makers.length ? supabase.from("videos").select("actress_name,popularity").in("maker_name", makers).neq("actress_name", name).order("popularity", { ascending: false }).limit(1000) : Promise.resolve({ data: [] }),
    genres.length ? supabase.from("videos").select("actress_name,popularity").in("genre", genres).neq("actress_name", name).order("popularity", { ascending: false }).limit(1000) : Promise.resolve({ data: [] }),
  ]);
  return {
    name,
    profileUrl: profileResult.data?.profile_url ?? null,
    works: toWorkDetails(fallbackWorks.data),
    total: fallbackCount.count ?? 0,
    workCount: allOwnWorks.data?.length ?? fallbackCount.count ?? 0,
    makerCount: makers.length,
    sameMakerActresses: aggregate(makerRows.data ?? [], name),
    relatedActresses: aggregate(genreRows.data ?? [], name),
  };
}
