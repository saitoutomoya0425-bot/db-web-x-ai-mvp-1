import { NextResponse } from "next/server";
import { collectRecentXPosts } from "@/lib/collectors/x";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const secret = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || secret !== `Bearer ${process.env.CRON_SECRET}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const supabase = createAdminClient();
  const defaultQuery = process.env.X_COLLECTION_QUERY?.trim();
  const { data: stored } = await supabase.from("collection_sources").select("*").eq("source", "x").maybeSingle();
  const query = stored?.query || defaultQuery;
  if (!query) return NextResponse.json({ error: "X_COLLECTION_QUERY is not configured" }, { status: 503 });
  if (stored && (!stored.enabled || (stored.next_run_at && new Date(stored.next_run_at) > new Date()))) return NextResponse.json({ skipped: true });
  const { data: run, error: runError } = await supabase.from("collection_runs").insert({ source: "x", status: "running" }).select("id").single();
  if (runError) return NextResponse.json({ error: runError.message }, { status: 500 });
  try {
    const result = await collectRecentXPosts({ query, sinceId: stored?.since_id, maxPages: 5 });
    const status = result.rateLimitReset ? "rate_limited" : "completed";
    await Promise.all([
      supabase.from("collection_runs").update({ status, fetched_count: result.fetched, accepted_count: result.accepted, duplicate_count: result.duplicates, finished_at: new Date().toISOString() }).eq("id", run.id),
      supabase.from("collection_sources").upsert({ source: "x", query, since_id: result.newestId ?? stored?.since_id ?? null, enabled: stored?.enabled ?? true, last_run_at: new Date().toISOString(), next_run_at: result.rateLimitReset, last_error: null }, { onConflict: "source" }),
    ]);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await Promise.all([
      supabase.from("collection_runs").update({ status: "failed", error_message: message.slice(0, 2000), finished_at: new Date().toISOString() }).eq("id", run.id),
      supabase.from("collection_sources").upsert({ source: "x", query, enabled: true, last_run_at: new Date().toISOString(), last_error: message.slice(0, 2000) }, { onConflict: "source" }),
    ]);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export const GET = POST;
