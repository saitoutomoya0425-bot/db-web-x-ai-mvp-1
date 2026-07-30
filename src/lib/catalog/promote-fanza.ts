import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { safeImportErrorMessage } from "@/lib/fanza/import-state";
import type { NormalizedFanzaProduct } from "@/lib/fanza/normalize";
import type { Video } from "@/types/database";

type WritableVideo = Omit<Video, "id" | "created_at" | "updated_at">;

export async function promoteFanzaProducts(ids: string[], reviewerId: string) {
  const admin = createAdminClient();
  const { data: sourceProducts, error } = await admin.from("source_products").select("*").in("id", ids).eq("review_status", "pending");
  if (error) throw new Error(error.message);
  let promoted = 0;
  const errors: { id: string; message: string }[] = [];

  for (const sourceProduct of sourceProducts ?? []) {
    try {
      if (["duplicate", "needs_review"].includes(sourceProduct.preview_status)) {
        throw new Error("重複候補または要確認データは、修正・確認後に承認してください。");
      }
      const item = sourceProduct.normalized_data as NormalizedFanzaProduct;
      if (!item?.productCode || !item.title) throw new Error("品番とタイトルが必要です。");

      let existing: Video | null = null;
      if (sourceProduct.duplicate_video_id) {
        existing = (await admin.from("videos").select("*").eq("id", sourceProduct.duplicate_video_id).maybeSingle()).data;
      }
      if (!existing) existing = (await admin.from("videos").select("*").eq("product_code", item.productCode).maybeSingle()).data;

      const patch: Partial<WritableVideo> & Pick<WritableVideo, "product_code" | "title"> = {
        product_code: item.productCode,
        title: item.title,
      };
      if (item.actressNames[0]) patch.actress_name = item.actressNames[0];
      if (item.makerName) patch.maker_name = item.makerName;
      if (item.seriesName) patch.series_name = item.seriesName;
      if (item.labelName) patch.label_name = item.labelName;
      if (item.genres[0]) patch.genre = item.genres[0];
      if (item.releaseDate) patch.release_date = item.releaseDate;
      if (item.sampleImages.length) patch.sample_images = item.sampleImages;
      if (item.cardThumbnailUrl) patch.card_thumbnail_url = item.cardThumbnailUrl;
      if (item.thumbnailUrl) patch.thumbnail_url = item.thumbnailUrl;
      if (item.sampleVideoUrl) patch.video_url = item.sampleVideoUrl;
      if (item.officialUrl) patch.official_url = item.officialUrl;
      if (item.affiliateUrl) patch.affiliate_url = item.affiliateUrl;
      patch.source_name = "FANZA Webサービス";
      patch.external_product_id = item.externalProductId;
      patch.source_checked_at = sourceProduct.fetched_at;
      if (item.description) patch.description = item.description;
      const videoInput: WritableVideo = existing
        ? Object.assign({
            product_code: existing.product_code, title: existing.title,
            actress_id: existing.actress_id, maker_id: existing.maker_id, series_id: existing.series_id,
            actress_name: existing.actress_name, maker_name: existing.maker_name, series_name: existing.series_name,
            label_name: existing.label_name, genre: existing.genre, duration: existing.duration,
            release_date: existing.release_date, sample_images: existing.sample_images,
            card_thumbnail_url: existing.card_thumbnail_url,
            thumbnail_url: existing.thumbnail_url, video_url: existing.video_url, official_url: existing.official_url,
            affiliate_url: existing.affiliate_url, source_name: existing.source_name,
            external_product_id: existing.external_product_id, source_checked_at: existing.source_checked_at,
            description: existing.description, popularity: existing.popularity, favorite_count: existing.favorite_count,
            is_published: existing.is_published, content_category: existing.content_category,
          }, patch)
        : {
            product_code: item.productCode, title: item.title,
            actress_id: null, maker_id: null, series_id: null,
            actress_name: item.actressNames[0] ?? null, maker_name: item.makerName, series_name: item.seriesName,
            label_name: item.labelName, genre: item.genres[0] ?? null, duration: null,
            release_date: item.releaseDate, sample_images: item.sampleImages,
            card_thumbnail_url: item.cardThumbnailUrl,
            thumbnail_url: item.thumbnailUrl, video_url: item.sampleVideoUrl, official_url: item.officialUrl,
            affiliate_url: item.affiliateUrl, source_name: "FANZA Webサービス",
            external_product_id: item.externalProductId, source_checked_at: sourceProduct.fetched_at,
            description: item.description, popularity: 0, favorite_count: 0,
            is_published: false, content_category: "commercial_av",
          };
      const saved = await admin.from("videos").upsert(videoInput, { onConflict: "product_code" }).select("*").single();
      if (saved.error) throw new Error(saved.error.message);
      const video = saved.data;

      const actressNames = [...new Set(item.actressNames)];
      if (actressNames.length) {
        const { error: actressError } = await admin.from("actresses").upsert(actressNames.map((name) => ({ name })), { onConflict: "name", ignoreDuplicates: true });
        if (actressError) throw new Error(`女優同期: ${actressError.message}`);
      }
      if (item.makerName) {
        const { error: makerError } = await admin.from("makers").upsert({ name: item.makerName }, { onConflict: "name", ignoreDuplicates: true });
        if (makerError) throw new Error(`メーカー同期: ${makerError.message}`);
      }
      const [{ data: actress }, { data: maker }] = await Promise.all([
        item.actressNames[0] ? admin.from("actresses").select("id").eq("name", item.actressNames[0]).maybeSingle() : Promise.resolve({ data: null }),
        item.makerName ? admin.from("makers").select("id").eq("name", item.makerName).maybeSingle() : Promise.resolve({ data: null }),
      ]);
      let seriesId: string | null = null;
      if (item.seriesName) {
        const result = await admin.from("series").upsert({ name: item.seriesName, maker_id: maker?.id ?? null }, { onConflict: "name" }).select("id").single();
        if (result.error) throw new Error(`シリーズ同期: ${result.error.message}`);
        seriesId = result.data.id;
      }
      const { error: idError } = await admin.from("videos").update({
        actress_id: actress?.id ?? null, maker_id: maker?.id ?? null, series_id: seriesId,
      }).eq("id", video.id);
      if (idError) throw new Error(`補助ID同期: ${idError.message}`);
      if (actressNames.length) {
        const { data: allActresses, error: actressLookupError } = await admin
          .from("actresses").select("id,name").in("name", actressNames);
        if (actressLookupError) throw new Error(`女優関連取得: ${actressLookupError.message}`);
        const positionByName = new Map(actressNames.map((name, index) => [name, index]));
        const { error: clearActressesError } = await admin.from("video_actresses").delete().eq("video_id", video.id);
        if (clearActressesError) throw new Error(`女優関連更新: ${clearActressesError.message}`);
        if (allActresses?.length) {
          const { error: actressLinkError } = await admin.from("video_actresses").insert(
            allActresses.map((row) => ({
              video_id: video.id,
              actress_id: row.id,
              position: positionByName.get(row.name) ?? 0,
            })),
          );
          if (actressLinkError) throw new Error(`女優関連更新: ${actressLinkError.message}`);
        }
      }

      if (item.genres.length) {
        const uniqueGenres = [...new Set(item.genres)];
        const [{ error: genreError }, { error: tagError }] = await Promise.all([
          admin.from("genres").upsert(uniqueGenres.map((name) => ({ name })), { onConflict: "name", ignoreDuplicates: true }),
          admin.from("tags").upsert(uniqueGenres.map((name) => ({ name })), { onConflict: "name", ignoreDuplicates: true }),
        ]);
        if (genreError || tagError) throw new Error(`ジャンル同期: ${genreError?.message ?? tagError?.message}`);
        const [{ data: genres }, { data: tags }] = await Promise.all([
          admin.from("genres").select("id,name").in("name", uniqueGenres),
          admin.from("tags").select("id,name").in("name", uniqueGenres),
        ]);
        await Promise.all([
          admin.from("video_genres").delete().eq("video_id", video.id),
          admin.from("video_tags").delete().eq("video_id", video.id),
        ]);
        if (genres?.length) await admin.from("video_genres").insert(genres.map((genre) => ({ video_id: video.id, genre_id: genre.id })));
        if (tags?.length) await admin.from("video_tags").insert(tags.map((tag) => ({ video_id: video.id, tag_id: tag.id })));
      }

      const { error: offerError } = await admin.from("product_offers").upsert({
        video_id: video.id,
        data_source_id: sourceProduct.data_source_id,
        source_product_id: sourceProduct.id,
        external_product_id: sourceProduct.external_product_id,
        seller_name: "FANZA",
        official_url: item.officialUrl,
        affiliate_url: item.affiliateUrl,
        price: item.price,
        currency: item.currency,
        availability_status: item.availabilityStatus,
        last_checked_at: sourceProduct.fetched_at,
      }, { onConflict: "data_source_id,external_product_id" });
      if (offerError) throw new Error(`販売情報同期: ${offerError.message}`);
      await admin.from("video_source_links").upsert({
        video_id: video.id, source_product_id: sourceProduct.id, confidence: 1,
      }, { onConflict: "video_id,source_product_id" });

      if (existing) {
        const changedFields = (Object.keys(patch) as (keyof WritableVideo)[])
          .filter((key) => JSON.stringify(existing?.[key as keyof Video]) !== JSON.stringify(patch[key]));
        if (changedFields.length) await admin.from("video_change_logs").insert({
          video_id: video.id, changed_fields: changedFields, before_data: existing, after_data: video, change_source: "fanza_api",
        });
      }
      await admin.from("source_products").update({
        review_status: "promoted", promoted_video_id: video.id, reviewed_at: new Date().toISOString(),
        reviewed_by: reviewerId, error_message: null,
      }).eq("id", sourceProduct.id);
      promoted++;
    } catch (cause) {
      const message = safeImportErrorMessage(cause, [
        process.env.FANZA_API_ID ?? "",
        process.env.FANZA_AFFILIATE_ID ?? "",
      ]);
      errors.push({ id: sourceProduct.id, message });
      await admin.from("source_products").update({ review_status: "error", error_message: message.slice(0, 2000) }).eq("id", sourceProduct.id);
      if (sourceProduct.import_job_id) {
        await admin.from("fanza_import_errors").insert({
          job_id: sourceProduct.import_job_id,
          external_product_id: sourceProduct.external_product_id,
          original_product_code: sourceProduct.original_product_code,
          processing_stage: "promote",
          error_type: "product_promotion_failed",
          attempt_count: Math.max(1, Number(sourceProduct.attempt_count) || 1),
          message,
          raw_payload: null,
          retryable: true,
        });
      }
    }
  }
  return { promoted, errors };
}
