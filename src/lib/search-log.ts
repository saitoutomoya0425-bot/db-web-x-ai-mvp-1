import { createClient } from "@/lib/supabase/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, validSessionId } from "@/lib/analytics-session";

export async function saveSearchLog(input: {
  productCode: string;
  source: string;
  userAgent?: string | null;
  referrer?: string | null;
}) {
  const supabase = await createClient();
  const sessionId = validSessionId((await cookies()).get(SESSION_COOKIE)?.value);
  const { error } = await supabase.from("search_logs").insert({
    product_code: input.productCode.toUpperCase(),
    source: input.source.slice(0, 50),
    user_agent: input.userAgent?.slice(0, 500) ?? null,
    referrer: input.referrer?.slice(0, 1000) ?? null,
    session_id: sessionId,
  });
  if (error) console.error("Failed to save search log:", error.message);
}
