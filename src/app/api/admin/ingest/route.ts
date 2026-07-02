import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const itemSchema = z.object({
  source: z.string().trim().min(1).max(50),
  source_key: z.string().trim().min(1).max(500),
  source_url: z.string().url().max(2000).nullish(),
  observed_at: z.string().datetime().nullish(),
  product_code: z.string().trim().max(100).nullish(),
  title: z.string().trim().max(1000).nullish(),
  actress_name: z.string().trim().max(300).nullish(),
  maker_name: z.string().trim().max(300).nullish(),
  series_name: z.string().trim().max(500).nullish(),
  tags: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
  payload: z.record(z.string(), z.unknown()).default({}),
});
const bodySchema = z.object({ items: z.array(itemSchema).min(1).max(1000) });

export async function POST(request: Request) {
  const apiKey = request.headers.get("x-ingest-key");
  const keyAuthorized = Boolean(process.env.INGEST_API_KEY && apiKey === process.env.INGEST_API_KEY);
  if (!keyAuthorized) {
    const client = await createClient();
    const { data: { user } } = await client.auth.getUser();
    if (!user || user.app_metadata?.role !== "admin") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  const rows = parsed.data.items.map((item) => ({
    ...item, observed_at: item.observed_at ?? new Date().toISOString(),
    product_code: item.product_code?.toUpperCase() || null, source_url: item.source_url || null,
    title: item.title || null, actress_name: item.actress_name || null, maker_name: item.maker_name || null,
    series_name: item.series_name || null, status: "pending",
  }));
  const { data, error } = await createAdminClient().from("source_items").upsert(rows, { onConflict: "source,source_key", ignoreDuplicates: true }).select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ accepted: data?.length ?? 0, duplicates: rows.length - (data?.length ?? 0) }, { status: 202 });
}
