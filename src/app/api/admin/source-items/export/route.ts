import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 60;
const columns = ["source","source_key","source_url","observed_at","product_code","title","actress_name","maker_name","series_name","tags","status"] as const;
const csv = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""').replace(/[\r\n]+/g, " ")}"`;

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.app_metadata?.role !== "admin") return new Response("Unauthorized", { status: 401 });
  let lastId = 0, finished = false, header = true;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return controller.close();
      const { data, error } = await supabase.from("source_items").select("id,source,source_key,source_url,observed_at,product_code,title,actress_name,maker_name,series_name,tags,status").gt("id", lastId).order("id").limit(1000);
      if (error) return controller.error(new Error(error.message));
      if (!data?.length) { finished = true; return controller.close(); }
      lastId = data[data.length - 1].id;
      const body = data.map((row) => columns.map((key) => csv(key === "tags" ? row.tags.join("|") : row[key])).join(",")).join("\r\n");
      controller.enqueue(encoder.encode(`${header ? `${columns.join(",")}\r\n` : ""}${body}\r\n`));
      header = false;
    },
  });
  return new Response(stream, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="source-items-${new Date().toISOString().slice(0,10)}.csv"`, "cache-control": "no-store" } });
}
