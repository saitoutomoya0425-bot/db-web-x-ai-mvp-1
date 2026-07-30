import "server-only";
import { createHash } from "node:crypto";
import { fetchFanzaProducts } from "@/lib/fanza/client";
import {
  runFanzaBatch,
  type ExistingProduct,
  type ProductLookup,
  type StagedProduct,
} from "@/lib/fanza/pipeline";
import { buildItemErrorRecord, nextErrorAttempt, nextSourceState } from "@/lib/fanza/import-state";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database, Video } from "@/types/database";

type Job = Database["public"]["Tables"]["fanza_import_jobs"]["Row"];
export class FanzaJobStepError extends Error {
  constructor(
    public readonly stage: "fetch" | "deduplicate" | "persist" | "unknown",
    message: string,
  ) {
    super(message);
    this.name = "FanzaJobStepError";
  }
}

function existing(video: Video): ExistingProduct {
  return {
    id: video.id,
    kind: "video",
    externalProductId: video.external_product_id,
    normalizedProductCode: video.product_code.toUpperCase().replace(/[^A-Z0-9]/g, ""),
    title: video.title,
    actressNames: video.actress_name ? [video.actress_name] : [],
    makerName: video.maker_name,
    seriesName: video.series_name,
    genres: video.genre ? [video.genre] : [],
  };
}

export async function runFanzaImportJobStep(job: Job) {
  const admin = createAdminClient();
  const sourceCandidate = (row: Database["public"]["Tables"]["source_products"]["Row"]): ExistingProduct => {
    const normalized = row.normalized_data as Partial<StagedProduct["normalized"]> | null;
    return {
      id: row.id,
      kind: "source",
      externalProductId: row.external_product_id,
      normalizedProductCode: row.normalized_product_code,
      title: normalized?.title ?? null,
      actressNames: normalized?.actressNames ?? [],
      makerName: normalized?.makerName ?? null,
      seriesName: normalized?.seriesName ?? null,
      genres: normalized?.genres ?? [],
      reviewStatus: row.review_status,
      previewStatus: row.preview_status as ExistingProduct["previewStatus"],
      attemptCount: row.attempt_count,
      linkedVideoId: row.promoted_video_id ?? row.duplicate_video_id,
    };
  };
  const lookup: ProductLookup = {
    async byExternalIds(ids) {
      if (!ids.length) return new Map();
      const [{ data: videos, error: videoError }, { data: sources, error: sourceError }] = await Promise.all([
        admin.rpc("match_videos_for_import", { external_ids: ids, normalized_codes: [] }),
        admin.from("source_products").select("*").eq("data_source_id", job.data_source_id).in("external_product_id", ids),
      ]);
      if (videoError || sourceError) throw new FanzaJobStepError("deduplicate", `既存作品照合: ${videoError?.message ?? sourceError?.message}`);
      return new Map(ids.map((id) => [id, [
        ...(videos ?? []).filter((video) => video.external_product_id === id).map(existing),
        ...(sources ?? []).filter((source) => source.external_product_id === id).map(sourceCandidate),
      ]]));
    },
    async byNormalizedCodes(codes) {
      if (!codes.length) return new Map();
      const [{ data: videos, error: videoError }, { data: sources, error: sourceError }] = await Promise.all([
        admin.rpc("match_videos_for_import", {
          external_ids: [],
          normalized_codes: codes.map((code) => code.toLowerCase()),
        }),
        admin.from("source_products").select("*").eq("data_source_id", job.data_source_id).in("normalized_product_code", codes),
      ]);
      if (videoError || sourceError) throw new FanzaJobStepError("deduplicate", `既存品番照合: ${videoError?.message ?? sourceError?.message}`);
      return new Map(codes.map((code) => [
        code,
        [
          ...(videos ?? []).filter((video) => video.product_code.toUpperCase().replace(/[^A-Z0-9]/g, "") === code).map(existing),
          ...(sources ?? []).filter((source) => source.normalized_product_code === code).map(sourceCandidate),
        ],
      ]));
    },
  };
  const persist = async (products: StagedProduct[]) => {
    const now = new Date().toISOString();
    const rows = products.map((product) => {
      const state = nextSourceState(product);
      return {
      data_source_id: job.data_source_id,
      import_job_id: job.id,
      external_product_id: product.externalProductId,
      product_code: product.normalized.productCode,
      original_product_code: product.normalized.originalProductCode,
      normalized_product_code: product.normalized.normalizedProductCode,
      raw_payload: product.rawPayload,
      normalized_data: product.normalized,
      payload_hash: product.payloadHash || createHash("sha256").update(JSON.stringify(product.rawPayload)).digest("hex"),
      fetched_at: now,
      preview_status: state.previewStatus,
      review_status: state.reviewStatus,
      duplicate_video_id: product.duplicateVideoId,
      error_message: product.reviewReasons.length ? product.reviewReasons.join(",") : null,
      attempt_count: state.attemptCount,
      last_attempt_at: now,
      next_retry_at: null,
      };
    });
    const { error } = await admin.from("source_products").upsert(rows, {
      onConflict: "data_source_id,external_product_id",
    });
    if (error) {
      const failures: typeof rows = [];
      for (const row of rows) {
        const result = await admin.from("source_products").upsert(row, {
          onConflict: "data_source_id,external_product_id",
        });
        if (result.error) {
          failures.push(row);
          await admin.from("fanza_import_errors").insert({
            job_id: job.id,
            external_product_id: row.external_product_id,
            original_product_code: row.original_product_code,
            api_offset: job.next_offset,
            processing_stage: "persist",
            error_type: "source_product_upsert_failed",
            attempt_count: row.attempt_count,
            message: "候補データの保存に失敗しました。",
            raw_payload: row.raw_payload,
            retryable: true,
          });
        }
      }
      if (failures.length) throw new FanzaJobStepError("persist", `候補保存に失敗した作品があります（${failures.length}件）。`);
    }
    const externalIds = rows.map((row) => row.external_product_id);
    if (externalIds.length) {
      await admin.from("fanza_import_errors").update({ resolved_at: now })
        .eq("job_id", job.id)
        .in("external_product_id", externalIds)
        .in("processing_stage", ["normalize", "deduplicate", "persist"])
        .is("resolved_at", null);
    }
  };
  const output = await runFanzaBatch({
    checkpoint: {
      offset: job.next_offset,
      processed: Number(job.processed_count),
      staged: Number(job.staged_count),
      failed: Number(job.failed_count),
      completed: job.status === "completed",
    },
    batchSize: job.page_size,
    maxItems: job.max_items,
    dryRun: job.dry_run,
    fetchPage: async (offset, limit) => {
      try {
        const fetched = await fetchFanzaProducts({
          offset,
          limit,
          keyword: job.keyword,
          maxRetries: 3,
        });
        return { rawItems: fetched.rawItems, hasMore: fetched.pagination.hasMore };
      } catch (error) {
        throw new FanzaJobStepError("fetch", error instanceof Error ? error.message : "API取得に失敗しました。");
      }
    },
    lookup,
    persist,
  });
  if (!job.dry_run && output.result.errors.length) {
    const records = output.result.errors.map((error) => buildItemErrorRecord({
      jobId: job.id,
      apiOffset: job.next_offset,
      error,
      attemptCount: Number(job.retry_count) + 1,
    }));
    for (const record of records) {
      let query = admin.from("fanza_import_errors").select("id,attempt_count")
        .eq("job_id", record.job_id)
        .eq("api_offset", record.api_offset)
        .eq("processing_stage", record.processing_stage)
        .eq("error_type", record.error_type)
        .is("resolved_at", null);
      query = record.external_product_id
        ? query.eq("external_product_id", record.external_product_id)
        : query.is("external_product_id", null);
      const { data: previous, error: previousError } = await query.order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (previousError) throw new Error(`作品エラー照合: ${previousError.message}`);
      const result = previous
        ? await admin.from("fanza_import_errors").update({
            ...record,
            attempt_count: nextErrorAttempt(previous.attempt_count),
          }).eq("id", previous.id)
        : await admin.from("fanza_import_errors").insert(record);
      if (result.error) throw new Error(`作品エラー保存: ${result.error.message}`);
    }
  }
  const next = output.checkpoint;
  const status = next.completed ? "completed" : "paused";
  const { error } = await admin.from("fanza_import_jobs").update({
    status,
    next_offset: next.offset,
    processed_count: next.processed,
    staged_count: next.staged,
    failed_count: next.failed,
    unchanged_count: Number(job.unchanged_count) + output.result.counts.unchanged,
    duplicate_count: Number(job.duplicate_count) + output.result.counts.duplicate,
    needs_review_count: Number(job.needs_review_count) + output.result.counts.needs_review,
    last_error: null,
    started_at: job.started_at ?? new Date().toISOString(),
    completed_at: next.completed ? new Date().toISOString() : null,
  }).eq("id", job.id);
  if (error) throw new Error(`ジョブ更新: ${error.message}`);
  return { status, checkpoint: next, counts: output.result.counts, errors: output.result.errors };
}
