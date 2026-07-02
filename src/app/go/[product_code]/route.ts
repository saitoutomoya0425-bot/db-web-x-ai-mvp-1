import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getWorkByCode } from "@/lib/queries/public-works";

export async function GET(request: Request, { params }: { params: Promise<{ product_code: string }> }) {
  const work = await getWorkByCode((await params).product_code);
  if (!work) return NextResponse.redirect(new URL("/", request.url));
  const requestedStore = new URL(request.url).searchParams.get("store");
  const store = requestedStore === "dmm" || requestedStore === "fanza" ? requestedStore : "other";
  const fallback = new URL(`/work/${encodeURIComponent(work.product_code)}?clicked=${store}`, request.url);
  try {
    const destination = work.affiliate_url ? new URL(work.affiliate_url) : null;
    if (destination && !["http:", "https:"].includes(destination.protocol)) throw new Error("Invalid protocol");
    const supabase = await createClient();
    await supabase.from("affiliate_clicks").insert({
      product_code: work.product_code,
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
