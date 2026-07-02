import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 60;
export async function GET(request: Request) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const client=createAdminClient();
  const [{error},{error:keywordError},{error:qualityError},{error:affiliateError}] = await Promise.all([client.rpc("refresh_discovery_metrics"),client.rpc("refresh_keyword_metrics"),client.rpc("refresh_ai_quality_snapshot"),client.rpc("apply_affiliate_template",{batch_limit:50000})]);
  if (error || keywordError || qualityError || affiliateError) return NextResponse.json({ error: error?.message ?? keywordError?.message ?? qualityError?.message ?? affiliateError?.message }, { status: 500 });
  return NextResponse.json({ refreshed: true, at: new Date().toISOString() });
}
export const POST = GET;
