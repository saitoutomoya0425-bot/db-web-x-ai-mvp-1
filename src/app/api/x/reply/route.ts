import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getWorkByCode, normalizeCode } from "@/lib/queries/public-works";

export const runtime = "nodejs";

function authorized(request: Request) {
  const expected = process.env.X_REPLY_API_KEY;
  const received = request.headers.get("x-api-key") ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || !received) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  if (!process.env.X_REPLY_API_KEY) return NextResponse.json({ error: "X reply API is not configured" }, { status: 503 });
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null);
  const rawCode = typeof body?.code === "string" ? body.code : "";
  if (!rawCode) return NextResponse.json({ error: "code is required" }, { status: 400 });
  const code = normalizeCode(rawCode);
  const sourceTweetId = typeof body.source_tweet_id === "string" ? body.source_tweet_id.slice(0, 100) : null;
  const requestKey = sourceTweetId
    ? `tweet:${sourceTweetId}`
    : `manual:${createHash("sha256").update(`${code}:${body.request_id ?? ""}`).digest("hex")}`;
  const admin = createAdminClient();
  const { data: existing } = await admin.from("x_reply_requests").select("*").eq("request_key", requestKey).maybeSingle();
  if (existing) return NextResponse.json({ ok: true, duplicate: true, text: existing.reply_text, product_code: existing.product_code });

  const work = await getWorkByCode(code);
  if (!work) return NextResponse.json({ error: "Work not found", product_code: code }, { status: 404 });
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? new URL(request.url).origin;
  const url = `${site}/work/${encodeURIComponent(work.product_code)}`;
  const text = [`品番：${work.product_code}`, `女優：${work.actresses?.name ?? "不明"}`, "他の作品・類似作品はこちら", url].join("\n");
  const { error } = await admin.from("x_reply_requests").insert({
    request_key: requestKey, product_code: work.product_code, reply_text: text, source_tweet_id: sourceTweetId,
  });
  if (error && error.code !== "23505") return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, duplicate: error?.code === "23505", text, product_code: work.product_code, actress: work.actresses?.name ?? null, url });
}
