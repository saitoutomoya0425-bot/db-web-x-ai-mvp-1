import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const schema = z.object({ ids: z.array(z.string().uuid()).min(1).max(20), action: z.literal("reject") });

export async function POST(request: Request) {
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || user.app_metadata?.role !== "admin") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  const { error } = await createAdminClient().from("source_products").update({
    review_status: "rejected", reviewed_at: new Date().toISOString(), reviewed_by: user.id, error_message: null,
  }).in("id", parsed.data.ids).eq("review_status", "pending");
  return error ? NextResponse.json({ error: error.message }, { status: 500 }) : NextResponse.json({ rejected: parsed.data.ids.length });
}
