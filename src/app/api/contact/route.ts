import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";

const schema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(320),
  subject: z.enum(["一般のお問い合わせ", "掲載情報の修正", "権利・削除依頼", "その他"]),
  message: z.string().trim().min(10).max(5000),
  consent: z.literal("yes"),
  company: z.string().max(0).optional(),
});

export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "入力内容をご確認ください。" }, { status: 400 });
  const { error } = await createAdminClient().from("contact_messages").insert({
    name: parsed.data.name,
    email: parsed.data.email,
    subject: parsed.data.subject,
    message: parsed.data.message,
    status: "unread",
    user_agent: request.headers.get("user-agent")?.slice(0, 500) ?? null,
    referrer: request.headers.get("referer")?.slice(0, 1000) ?? null,
  });
  if (error) {
    console.error("contact submission failed", error.message);
    return NextResponse.json({ error: "送信できませんでした。時間をおいてお試しください。" }, { status: 500 });
  }
  return NextResponse.json({ accepted: true }, { status: 201 });
}
