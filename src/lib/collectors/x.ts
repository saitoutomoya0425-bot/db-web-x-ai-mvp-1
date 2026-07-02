import { createAdminClient } from "@/lib/supabase/admin";

type XPost = { id: string; text: string; created_at?: string; author_id?: string; lang?: string };
type XResponse = { data?: XPost[]; meta?: { newest_id?: string; next_token?: string }; errors?: unknown[] };

const PRODUCT_CODE = /\b([A-Z]{2,12})[\s_-]?(\d{2,8})\b/gi;
const labeled = (text: string, labels: string[]) => {
  const pattern = new RegExp(`(?:${labels.join("|")})[：:]\\s*([^\\n、,]{1,80})`, "i");
  return text.match(pattern)?.[1]?.trim() ?? null;
};
export function extractCandidates(post: XPost) {
  const codes = [...post.text.matchAll(PRODUCT_CODE)].map((match) => `${match[1].toUpperCase()}-${match[2]}`);
  const tags = [...post.text.matchAll(/#([^\s#]{1,50})/g)].map((match) => match[1]).slice(0, 30);
  return [...new Set(codes)].map((product_code) => ({
    source: "x", source_key: `${post.id}:${product_code}`, source_url: `https://x.com/i/web/status/${post.id}`,
    observed_at: post.created_at ?? new Date().toISOString(), product_code,
    title: labeled(post.text, ["タイトル", "作品名"]),
    actress_name: labeled(post.text, ["女優", "出演"]),
    maker_name: labeled(post.text, ["メーカー", "レーベル"]),
    series_name: labeled(post.text, ["シリーズ"]), tags,
    payload: { post_id: post.id, text: post.text, author_id: post.author_id, lang: post.lang },
    status: "pending",
  }));
}

export async function collectRecentXPosts(options: { query: string; sinceId?: string | null; maxPages?: number }) {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) throw new Error("X_BEARER_TOKEN is not configured");
  const supabase = createAdminClient();
  let nextToken: string | undefined, newestId: string | undefined;
  let fetched = 0, accepted = 0, duplicates = 0, rateLimitReset: string | null = null;
  for (let page = 0; page < Math.min(Math.max(options.maxPages ?? 5, 1), 20); page++) {
    const params = new URLSearchParams({ query: options.query, max_results: "100", "tweet.fields": "created_at,author_id,lang" });
    if (options.sinceId) params.set("since_id", options.sinceId);
    if (nextToken) params.set("next_token", nextToken);
    const response = await fetch(`https://api.x.com/2/tweets/search/recent?${params}`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
    if (response.status === 429) {
      const reset = Number(response.headers.get("x-rate-limit-reset"));
      rateLimitReset = Number.isFinite(reset) ? new Date(reset * 1000).toISOString() : new Date(Date.now() + 15 * 60_000).toISOString();
      break;
    }
    if (!response.ok) throw new Error(`X API ${response.status}: ${(await response.text()).slice(0, 500)}`);
    const payload = await response.json() as XResponse;
    const posts = payload.data ?? [];
    fetched += posts.length;
    newestId ??= payload.meta?.newest_id;
    const rows = posts.flatMap(extractCandidates);
    if (rows.length) {
      const { data, error } = await supabase.from("source_items").upsert(rows, { onConflict: "source,source_key", ignoreDuplicates: true }).select("id");
      if (error) throw new Error(error.message);
      accepted += data?.length ?? 0;
      duplicates += rows.length - (data?.length ?? 0);
    }
    nextToken = payload.meta?.next_token;
    if (!nextToken) break;
  }
  return { fetched, accepted, duplicates, newestId, rateLimitReset };
}
