import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

function sortById(rows) {
  return [...rows].sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function canonicalVideo(row) {
  return {
    id: row.id,
    external_product_id: row.external_product_id ?? null,
    product_code: row.product_code ?? null,
  };
}

function canonicalSource(row) {
  return {
    id: row.id,
    data_source_id: row.data_source_id,
    external_product_id: row.external_product_id,
    normalized_product_code: row.normalized_product_code ?? null,
    payload_hash: row.payload_hash ?? null,
    review_status: row.review_status ?? null,
    preview_status: row.preview_status ?? null,
    promoted_video_id: row.promoted_video_id ?? null,
    duplicate_video_id: row.duplicate_video_id ?? null,
    import_job_id: row.import_job_id ?? null,
    attempt_count: row.attempt_count ?? null,
  };
}

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function canonicalTargetScope(scope) {
  return {
    videos: sortById(scope.videos ?? []).map(canonicalVideo),
    source_products: sortById(scope.sources ?? []).map(canonicalSource),
  };
}

export function summarizeTargetScope(scope) {
  const canonical = canonicalTargetScope(scope);
  return {
    videos: canonical.videos.length,
    source_products: canonical.source_products.length,
    evidence_sha256: sha256(canonical),
  };
}

export function assertDryRunTargetScopeUnchanged(before, after) {
  if (!isDeepStrictEqual(canonicalTargetScope(before), canonicalTargetScope(after))) {
    throw new Error("DRY_RUN_TARGET_SCOPE_CHANGED");
  }
}

export function assertWriteTargetScope(options) {
  const before = canonicalTargetScope(options.before);
  const after = canonicalTargetScope(options.after);
  const plannedByExternalId = new Map(
    options.plannedRows.map((row) => [row.external_product_id, row]),
  );
  if (plannedByExternalId.size !== options.plannedRows.length) {
    throw new Error("PLANNED_TARGET_DUPLICATE");
  }

  if (!isDeepStrictEqual(before.videos, after.videos)) {
    throw new Error("TARGET_VIDEO_MUTATION_DETECTED");
  }

  const beforeUnaffected = before.source_products.filter(
    (row) => !plannedByExternalId.has(row.external_product_id),
  );
  const afterUnaffected = after.source_products.filter(
    (row) => !plannedByExternalId.has(row.external_product_id),
  );
  if (!isDeepStrictEqual(beforeUnaffected, afterUnaffected)) {
    throw new Error("UNEXPECTED_TARGET_SOURCE_MUTATION");
  }

  for (const [externalProductId, planned] of plannedByExternalId) {
    const beforeMatches = before.source_products.filter(
      (row) => row.external_product_id === externalProductId,
    );
    const afterMatches = after.source_products.filter(
      (row) => row.external_product_id === externalProductId,
    );
    if (beforeMatches.length !== 0 || afterMatches.length !== 1) {
      throw new Error(`TARGET_SOURCE_DELTA_MISMATCH_${externalProductId}`);
    }
    const actual = afterMatches[0];
    if (
      actual.data_source_id !== planned.data_source_id
      || actual.normalized_product_code !== planned.normalized_product_code
      || actual.payload_hash !== planned.payload_hash
      || actual.review_status !== "pending"
      || actual.preview_status !== "new"
      || actual.import_job_id !== options.importJobId
      || actual.promoted_video_id !== null
      || actual.duplicate_video_id !== null
    ) {
      throw new Error(`SAVED_ROW_MISMATCH_${externalProductId}`);
    }
  }

  if (after.source_products.length - before.source_products.length !== options.plannedRows.length) {
    throw new Error("TARGET_SOURCE_PRODUCT_DELTA_MISMATCH");
  }
  return {
    exact_target_rows_added: options.plannedRows.length,
    exact_target_rows_unchanged: beforeUnaffected.length,
    unexpected_target_mutation: 0,
  };
}
