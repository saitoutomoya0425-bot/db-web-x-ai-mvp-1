import type { PreviewStatus, StageError, StagedProduct } from "./pipeline.ts";

export type PreservedSourceState = {
  reviewStatus: string;
  attemptCount: number;
  previewStatus: PreviewStatus;
};

export function nextSourceState(product: StagedProduct): PreservedSourceState {
  const protectedPreview = product.existingPreviewStatus === "needs_review"
    || product.existingPreviewStatus === "duplicate"
    ? product.existingPreviewStatus
    : product.previewStatus;
  return {
    reviewStatus: product.existingReviewStatus ?? "pending",
    attemptCount: Math.max(0, product.existingAttemptCount ?? 0) + 1,
    previewStatus: protectedPreview,
  };
}

export function nextErrorAttempt(existingAttemptCount: number | null | undefined) {
  return Math.max(0, existingAttemptCount ?? 0) + 1;
}

export function safeImportErrorMessage(error: unknown, secrets: string[] = []) {
  let message = error instanceof Error ? error.message : String(error || "処理に失敗しました。");
  message = message
    .replace(/((?:api_id|affiliate_id|token|key|secret)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/(bearer\s+)[a-z0-9._~+/=-]+/gi, "$1[REDACTED]");
  for (const secret of secrets.filter((value) => value.length >= 6)) {
    message = message.split(secret).join("[REDACTED]");
  }
  return message.slice(0, 2000);
}

export function buildItemErrorRecord(options: {
  jobId: string;
  apiOffset: number;
  error: StageError;
  attemptCount: number;
}) {
  return {
    job_id: options.jobId,
    external_product_id: options.error.externalProductId,
    original_product_code: options.error.originalProductCode,
    api_offset: options.apiOffset + options.error.index,
    processing_stage: options.error.stage,
    error_type: options.error.errorType,
    attempt_count: Math.max(1, options.attemptCount),
    error_code: options.error.errorCode,
    message: safeImportErrorMessage(options.error.message),
    raw_payload: options.error.rawPayload,
    retryable: options.error.retryable,
  };
}
