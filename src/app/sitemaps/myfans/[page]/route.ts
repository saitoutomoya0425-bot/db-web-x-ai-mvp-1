import { MYFANS_SITEMAP_PAGE_SIZE } from "@/lib/public-catalog/sitemap-plan";
import { getMyFansPublicSitemapPage } from "@/lib/queries/myfans-public";

function xml(value: string) {
  return value.replace(/[<>&'"]/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[character] ?? character);
}

export async function GET(_request: Request, { params }: { params: Promise<{ page: string }> }) {
  const page = Number((await params).page.replace(/\.xml$/, ""));
  if (!Number.isSafeInteger(page) || page < 0) return new Response("Not found", { status: 404 });
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const works = await getMyFansPublicSitemapPage(page, MYFANS_SITEMAP_PAGE_SIZE);
  if (!works.length) return new Response("Not found", { status: 404 });
  const urls = works
    .map((work) => `<url><loc>${xml(`${site}${work.detailHref}`)}</loc></url>`)
    .join("");
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`, {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
  });
}
