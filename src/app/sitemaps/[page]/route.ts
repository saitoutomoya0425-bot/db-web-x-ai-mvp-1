import { createClient } from "@/lib/supabase/server";
import { FANZA_SITEMAP_PAGE_SIZE } from "@/lib/public-catalog/sitemap-plan";

function xml(value: string) {
  return value.replace(/[<>&'"]/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[character] ?? character);
}
export async function GET(_request: Request, { params }: { params: Promise<{ page: string }> }) {
  const page = Number((await params).page.replace(/\.xml$/, ""));
  if (!Number.isInteger(page) || page < 0) return new Response("Not found", { status: 404 });
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const supabase = await createClient();
  const start = page * FANZA_SITEMAP_PAGE_SIZE;
  const { data, error } = await supabase.from("videos").select("product_code,updated_at").eq("is_published", true).order("id").range(start, start + FANZA_SITEMAP_PAGE_SIZE - 1);
  if (error) throw new Error("FANZA_SITEMAP_QUERY_FAILED");
  if (page > 0 && !(data ?? []).length) return new Response("Not found", { status: 404 });
  const staticUrls = page === 0 ? ["", "/works", "/makers", "/genres", "/ranking", "/rankings", "/rankings/actress", "/rankings/maker", "/rankings/series", "/about", "/contact", "/privacy", "/disclaimer"].map((path) => ({ url: `${site}${path}`, modified: new Date().toISOString() })) : [];
  const urls = [
    ...staticUrls,
    ...(data ?? []).map((work) => ({ url: `${site}/work/${encodeURIComponent(work.product_code)}`, modified: work.updated_at as string | null })),
  ].map((item) => `<url><loc>${xml(item.url)}</loc>${item.modified ? `<lastmod>${xml(item.modified)}</lastmod>` : ""}</url>`).join("");
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`, {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
  });
}
