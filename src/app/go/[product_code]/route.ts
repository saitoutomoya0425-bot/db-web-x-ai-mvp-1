import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getWorkByCode } from "@/lib/queries/public-works";
import { sessionFromCookieHeader } from "@/lib/analytics-session";
import { resolveSalesUrl } from "@/lib/fanza/sales-url";

export async function GET(request: Request, { params }: { params: Promise<{ product_code: string }> }) {
  const work = await getWorkByCode((await params).product_code);
  if (!work) return NextResponse.redirect(new URL("/", request.url));
  const requestedStore = new URL(request.url).searchParams.get("store");
  const store = requestedStore === "dmm" || requestedStore === "fanza" ? requestedStore : "other";
  const fallback = new URL(`/work/${encodeURIComponent(work.product_code)}`, request.url);
  try {
    const salesLink = resolveSalesUrl(work.affiliate_url, work.official_url ?? null);
    const destination = salesLink ? new URL(salesLink.url) : null;
    const supabase = await createClient();
    await supabase.from("affiliate_clicks").insert({
      product_code: work.product_code,
      video_id: work.id,
      session_id: sessionFromCookieHeader(request.headers.get("cookie")),
      source: new URL(request.url).searchParams.get("source")?.slice(0, 50) ?? "work_detail",
      store,
      destination_url: destination?.toString() ?? null,
      referrer: request.headers.get("referer")?.slice(0, 1000) ?? null,
      user_agent: request.headers.get("user-agent")?.slice(0, 500) ?? null,
    });
    return NextResponse.redirect(destination ?? fallback, 307);
  } catch {
    return NextResponse.redirect(fallback);
  }
}
