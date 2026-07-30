import { createClient } from "@/lib/supabase/server";

const xml = (value: string) => value.replace(/[<>&'"]/g, (character) => (
  { "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[character] ?? character
));

export async function GET() {
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const supabase = await createClient();
  const { data: videos } = await supabase.from("videos")
    .select("id,actress_name,maker_name,series_name,genre,updated_at")
    .eq("is_published", true).limit(10_000);
  const rows = videos ?? [];
  const actressNames = [...new Set(rows.map((item) => item.actress_name).filter((name): name is string => Boolean(name)))];
  const makerNames = [...new Set(rows.map((item) => item.maker_name).filter((name): name is string => Boolean(name)))];
  const seriesNames = [...new Set(rows.map((item) => item.series_name).filter((name): name is string => Boolean(name)))];
  const genreNames = [...new Set(rows.map((item) => item.genre).filter((name): name is string => Boolean(name)))];
  const videoIds = rows.map((item) => item.id);
  const { data: links } = videoIds.length
    ? await supabase.from("video_tags").select("tag_id").in("video_id", videoIds)
    : { data: [] };
  const tagIds = [...new Set((links ?? []).map((item) => item.tag_id))];
  const { data: tags } = tagIds.length
    ? await supabase.from("tags").select("name").in("id", tagIds)
    : { data: [] };
  const now = new Date().toISOString();
  const items = [
    ...actressNames.map((name) => ({ path: `/actress/${encodeURIComponent(name)}`, date: now })),
    ...makerNames.map((name) => ({ path: `/maker/${encodeURIComponent(name)}`, date: now })),
    ...seriesNames.map((name) => ({ path: `/series/${encodeURIComponent(name)}`, date: now })),
    ...(tags ?? []).map((item) => ({ path: `/tag/${encodeURIComponent(item.name)}`, date: now })),
    ...genreNames.map((name) => ({ path: `/genre/${encodeURIComponent(name)}`, date: now })),
  ];
  const urls = items.map((item) => `<url><loc>${xml(site + item.path)}</loc><lastmod>${xml(item.date)}</lastmod></url>`).join("");
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`, {
    headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, s-maxage=3600, stale-while-revalidate=86400" },
  });
}
