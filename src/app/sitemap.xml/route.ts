import { createPublicSitemapPlan } from "@/lib/public-catalog/sitemap-plan";
import { getMyFansPublicCount } from "@/lib/queries/myfans-public";
import { createClient } from "@/lib/supabase/server";

function xml(value: string) {
  return value.replace(/[<>&'"]/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[character] ?? character);
}

export async function GET() {
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const supabase = await createClient();
  const [fanzaCount, myFansCount] = await Promise.all([
    supabase.from("videos").select("id", { count: "exact", head: true }).eq("is_published", true),
    getMyFansPublicCount(),
  ]);
  if (fanzaCount.error) throw new Error("FANZA_PUBLIC_COUNT_QUERY_FAILED");
  const plan = createPublicSitemapPlan({ site, fanzaCount: fanzaCount.count ?? 0, myFansCount });
  const items = plan.entries.map((url) => `<sitemap><loc>${xml(url)}</loc></sitemap>`).join("");
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${items}</sitemapindex>`, {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
  });
}
