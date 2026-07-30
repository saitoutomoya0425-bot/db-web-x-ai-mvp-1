import { NextResponse } from "next/server";
import { z } from "zod";
import { promoteFanzaProducts } from "@/lib/catalog/promote-fanza";
import { createClient } from "@/lib/supabase/server";

const schema = z.object({ ids: z.array(z.string().uuid()).min(1).max(20) });

export async function POST(request: Request) {
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || user.app_metadata?.role !== "admin") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "1〜20件を選択してください。" }, { status: 400 });
  const result = await promoteFanzaProducts(parsed.data.ids, user.id);
  return NextResponse.json(result, { status: result.errors.length ? 207 : 200 });
}
