import { NextResponse } from "next/server";
import { getWorkByCode, normalizeCode } from "@/lib/queries/public-works";
import { saveSearchLog } from "@/lib/search-log";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const rawCode = searchParams.get("code");
  if (!rawCode) return NextResponse.json({ error: "code is required" }, { status: 400 });
  const code = normalizeCode(rawCode);
  const work = await getWorkByCode(code);
  await saveSearchLog({
    productCode: code,
    source: "x-reply-api",
    userAgent: request.headers.get("user-agent"),
    referrer: request.headers.get("referer"),
  });
  if (!work) return NextResponse.json({ error: "Work not found", code }, { status: 404 });
  const url = new URL(`/work/${encodeURIComponent(work.product_code)}`, process.env.NEXT_PUBLIC_SITE_URL ?? origin).toString();
  const text = [`品番：${work.product_code}`, `女優：${work.actresses?.name ?? "不明"}`, "この女優の他の作品・類似作品はこちら", url].join("\n");
  return NextResponse.json({ text, product_code: work.product_code, actress: work.actresses?.name ?? null, url });
}
