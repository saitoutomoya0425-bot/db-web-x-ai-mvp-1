import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { fetchFanzaProducts, fanzaConfiguration } from "@/lib/fanza/client";
import { fanzaSafetyReviewReasons } from "@/lib/fanza/pipeline";
import { normalizeProductCode } from "@/lib/queries/public-works";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const schema = z.object({
  limit: z.number().int().min(1).max(20).default(10),
  keyword: z.string().trim().max(100).nullable().optional(),
});

export async function GET() {
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || user.app_metadata?.role !== "admin") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const config = fanzaConfiguration();
  return NextResponse.json({
    configured: config.configured,
    status: config.configured ? "取得テストを実行できます" : "認証情報未設定のため取得テスト待ち",
    site: config.site,
    service: config.service,
    floor: config.floor,
    maxHits: 20,
  });
}

export async function POST(request: Request) {
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || user.app_metadata?.role !== "admin") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "取得件数は1〜20件で指定してください。" }, { status: 400 });
  if (!fanzaConfiguration().configured) {
    return NextResponse.json({ status: "waiting_credentials", message: "認証情報未設定のため取得テスト待ち" }, { status: 200 });
  }

  const admin = createAdminClient();
  try {
    const fetched = await fetchFanzaProducts(parsed.data);
    const { data: source, error: sourceError } = await admin.from("data_sources").upsert({
      name: "FANZA Webサービス", source_type: "api", priority: 10, is_active: true,
      terms_note: "DMM Webサービス API v3 ItemList。公式API応答のURLだけを保存。",
    }, { onConflict: "name" }).select("id").single();
    if (sourceError) throw sourceError;

    const codes = [...new Set(fetched.normalized.map((item) => item.productCode).filter((item): item is string => Boolean(item)))];
    const matches = new Map<string, { id: string; product_code: string; video: Record<string, unknown> }[]>();
    await Promise.all(codes.map(async (code) => {
      const { data } = await admin.rpc("search_videos", { search_query: code, sort_by: "popular", result_limit: 20, result_offset: 0 });
      matches.set(normalizeProductCode(code), (data ?? [])
        .filter((video) => normalizeProductCode(video.product_code) === normalizeProductCode(code))
        .map((video) => ({ id: video.id, product_code: video.product_code, video: video as unknown as Record<string, unknown> })));
    }));

    const rows = fetched.normalized.flatMap((item, index) => {
      if (!item.externalProductId) return [];
      const raw = fetched.rawItems[index];
      const candidates = item.normalizedProductCode ? matches.get(item.normalizedProductCode) ?? [] : [];
      const reviewReasons = fanzaSafetyReviewReasons(item);
      let previewStatus: "new" | "update" | "unchanged" | "duplicate" | "needs_review" = "new";
      if (reviewReasons.length) previewStatus = "needs_review";
      else if (candidates.length > 1) previewStatus = "duplicate";
      else if (candidates.length === 1) {
        const video = candidates[0].video;
        const expected = {
          title: item.title, actress_name: item.actressNames[0] ?? null, maker_name: item.makerName,
          series_name: item.seriesName, label_name: item.labelName, genre: item.genres[0] ?? null,
          release_date: item.releaseDate, card_thumbnail_url: item.cardThumbnailUrl, thumbnail_url: item.thumbnailUrl, video_url: item.sampleVideoUrl,
          affiliate_url: item.affiliateUrl, description: item.description,
        };
        const changed = Object.entries(expected).some(([key, value]) => value !== null && String(video[key] ?? "") !== String(value));
        previewStatus = changed ? "update" : "unchanged";
      }
      return [{
        data_source_id: source.id,
        external_product_id: item.externalProductId,
        product_code: item.productCode,
        original_product_code: item.originalProductCode,
        normalized_product_code: item.normalizedProductCode,
        raw_payload: raw,
        normalized_data: item,
        payload_hash: createHash("sha256").update(JSON.stringify(raw)).digest("hex"),
        fetched_at: new Date().toISOString(),
        preview_status: previewStatus,
        review_status: "pending",
        duplicate_video_id: candidates.length === 1 ? candidates[0].id : null,
        error_message: reviewReasons.length ? reviewReasons.join(",") : null,
      }];
    });
    if (rows.length) {
      const { error } = await admin.from("source_products").upsert(rows, { onConflict: "data_source_id,external_product_id" });
      if (error) throw error;
    }
    const counts = rows.reduce<Record<string, number>>((result, row) => {
      result[row.preview_status] = (result[row.preview_status] ?? 0) + 1;
      return result;
    }, {});
    return NextResponse.json({ fetched: fetched.rawItems.length, saved: rows.length, counts, request: fetched.request });
  } catch (error) {
    const message = error instanceof Error ? error.message : "FANZA API取得に失敗しました";
    await admin.from("system_error_logs").insert({ source: "fanza_connector", severity: "error", message: message.slice(0, 2000), context: {} });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
