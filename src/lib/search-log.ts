import { createClient } from "@/lib/supabase/server";

export async function saveSearchLog(input: {
  productCode: string;
  source: string;
  userAgent?: string | null;
  referrer?: string | null;
}) {
  const supabase = await createClient();
  const { error } = await supabase.from("search_logs").insert({
    product_code: input.productCode.toUpperCase(),
    source: input.source.slice(0, 50),
    user_agent: input.userAgent?.slice(0, 500) ?? null,
    referrer: input.referrer?.slice(0, 1000) ?? null,
  });
  if (error) console.error("Failed to save search log:", error.message);
}
