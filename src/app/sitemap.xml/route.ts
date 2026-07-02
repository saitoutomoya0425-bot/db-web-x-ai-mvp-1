import { createClient } from "@/lib/supabase/server";

const PAGE_SIZE = 50_000;
export async function GET() {
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const supabase = await createClient();
  const { count } = await supabase.from("videos").select("id", { count: "exact", head: true });
  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));
  const items = [`<sitemap><loc>${site}/sitemaps/entities.xml</loc></sitemap>`,...Array.from({ length: pages }, (_, page) => `<sitemap><loc>${site}/sitemaps/${page}.xml</loc></sitemap>`)].join("");
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${items}</sitemapindex>`, {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
  });
}
