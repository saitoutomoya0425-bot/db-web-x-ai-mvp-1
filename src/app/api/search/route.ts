import { NextResponse } from "next/server";
import { getWorkByCode, normalizeCode, searchVideos, type SearchSort } from "@/lib/queries/public-works";
import { saveSearchLog } from "@/lib/search-log";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const query = searchParams.get("q") ?? searchParams.get("code");
  if (!query?.trim()) return NextResponse.json({ error: "q or code is required" }, { status: 400 });
  const isCodeLookup = searchParams.has("code");
  await saveSearchLog({ productCode: query.trim(), source: searchParams.get("source") ?? "api", userAgent: request.headers.get("user-agent"), referrer: request.headers.get("referer") });
  if (isCodeLookup) {
    const code = normalizeCode(query);
    const work = await getWorkByCode(code);
    if (!work) return NextResponse.json({ error: "作品が見つかりませんでした", code }, { status: 404 });
    const path = `/work/${encodeURIComponent(work.product_code)}`;
    return NextResponse.json({ found: true, product_code: work.product_code, title: work.title, actress: work.actresses?.name ?? null, url: path, absolute_url: new URL(path, process.env.NEXT_PUBLIC_SITE_URL ?? origin).toString() });
  }
  const limit = Math.min(Math.max(Number(searchParams.get("limit")) || 24, 1), 100);
  const offset = Math.max(Number(searchParams.get("offset")) || 0, 0);
  const requestedSort = searchParams.get("sort");
  const sort: SearchSort = requestedSort === "new" || requestedSort === "release" ? requestedSort : "popular";
  const works = await searchVideos(query, limit, offset, sort);
  return NextResponse.json({ query, sort, count: works.length, data: works }, { headers: { "Cache-Control": "public, s-maxage=60" } });
}
