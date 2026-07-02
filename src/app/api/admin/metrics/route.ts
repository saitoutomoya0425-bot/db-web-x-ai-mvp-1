import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.app_metadata?.role !== "admin") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const [{error},{error:keywordError},{error:qualityError}] = await Promise.all([supabase.rpc("refresh_discovery_metrics"),supabase.rpc("refresh_keyword_metrics"),supabase.rpc("refresh_ai_quality_snapshot")]);
  if (error || keywordError || qualityError) return NextResponse.json({ error: error?.message ?? keywordError?.message ?? qualityError?.message }, { status: 500 });
  return NextResponse.json({ refreshed: true });
}
