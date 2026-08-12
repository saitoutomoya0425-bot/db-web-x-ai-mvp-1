import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../types/database.ts";
import { nextSourceState } from "./import-state.ts";
import type { StagedProduct } from "./pipeline.ts";

export const FANZA_SOURCE_PRODUCT_CONFLICT_KEY = "data_source_id,external_product_id";

export type FanzaSourceProductPersistenceRow = {
  data_source_id: string;
  import_job_id: string | null;
  external_product_id: string;
  product_code: string | null;
  original_product_code: string | null;
  normalized_product_code: string | null;
  raw_payload: unknown;
  normalized_data: StagedProduct["normalized"];
  payload_hash: string;
  fetched_at: string;
  preview_status: string;
  review_status: string;
  duplicate_video_id: string | null;
  error_message: string | null;
  attempt_count: number;
  last_attempt_at: string;
  next_retry_at: null;
};

export function buildStagedFanzaSourceRows(options: {
  dataSourceId: string;
  importJobId: string | null;
  products: StagedProduct[];
  fetchedAt: string;
}): FanzaSourceProductPersistenceRow[] {
  return options.products.map((product) => {
    const state = nextSourceState(product);
    return {
      data_source_id: options.dataSourceId,
      import_job_id: options.importJobId,
      external_product_id: product.externalProductId,
      product_code: product.normalized.productCode,
      original_product_code: product.normalized.originalProductCode,
      normalized_product_code: product.normalized.normalizedProductCode,
      raw_payload: product.rawPayload,
      normalized_data: product.normalized,
      payload_hash: product.payloadHash
        || createHash("sha256").update(JSON.stringify(product.rawPayload)).digest("hex"),
      fetched_at: options.fetchedAt,
      preview_status: state.previewStatus,
      review_status: state.reviewStatus,
      duplicate_video_id: product.duplicateVideoId,
      error_message: product.reviewReasons.length ? product.reviewReasons.join(",") : null,
      attempt_count: state.attemptCount,
      last_attempt_at: options.fetchedAt,
      next_retry_at: null,
    };
  });
}

export async function persistStagedFanzaProducts(options: {
  admin: SupabaseClient<Database>;
  dataSourceId: string;
  importJobId: string | null;
  products: StagedProduct[];
  fetchedAt: string;
}) {
  const rows = buildStagedFanzaSourceRows(options);
  if (!rows.length) return { saved: 0, rows };
  const { error } = await options.admin.from("source_products").upsert(rows, {
    onConflict: FANZA_SOURCE_PRODUCT_CONFLICT_KEY,
  });
  if (error) throw new Error("FANZA_CANDIDATE_BATCH_SAVE_FAILED");
  return { saved: rows.length, rows };
}
