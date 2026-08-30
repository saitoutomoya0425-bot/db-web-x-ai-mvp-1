import { createHash } from "node:crypto";
import { normalizeFanzaItem } from "../../src/lib/fanza/normalize.ts";
import { stageFanzaItems } from "../../src/lib/fanza/pipeline.ts";
import {
  fanzaFrontierMembershipSha256,
  fanzaFrontierPayloadMembershipSha256,
} from "../../src/lib/fanza/frontier.ts";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const CLASSIFICATIONS = [
  "EXISTING_UNCHANGED",
  "EXISTING_UPDATE",
  "SAFE_NEW",
  "NEEDS_REVIEW",
  "DUPLICATE",
  "INVALID",
  "ERROR",
];

export function priorityFrozenRecordsFromStaged({ candidates, staged, runTimestamp }) {
  if (!Array.isArray(candidates) || !candidates.length) throw new Error("PRIORITY_CANDIDATES_REQUIRED");
  if (!staged || !Array.isArray(staged.products) || !Array.isArray(staged.errors)) {
    throw new Error("PRIORITY_STAGED_RESULT_REQUIRED");
  }
  const productsById = new Map(staged.products.map((product) => [product.externalProductId, product]));
  const errorByIndex = new Map(staged.errors.map((error) => [error.index, error]));
  const seenIds = new Set();

  return candidates.map((candidate, index) => {
    const rawPayload = candidate.raw_payload;
    const normalized = normalizeFanzaItem(rawPayload);
    const payloadHash = sha256(JSON.stringify(rawPayload));
    const error = errorByIndex.get(index);
    const repeated = normalized.externalProductId && seenIds.has(normalized.externalProductId);
    if (normalized.externalProductId) seenIds.add(normalized.externalProductId);
    const product = productsById.get(normalized.externalProductId);
    const identityMismatch = candidate.external_product_id !== normalized.externalProductId
      || candidate.normalized_product_code !== normalized.normalizedProductCode;
    let classification;
    let reasons = [];
    if (error) {
      classification = "ERROR";
      reasons = [error.errorType];
    } else if (identityMismatch) {
      classification = "INVALID";
      reasons = ["priority_normalized_identity_mismatch"];
    } else if (!product) {
      classification = repeated ? "DUPLICATE" : "INVALID";
      reasons = [repeated ? "same_window_external_id_duplicate" : "staged_product_missing"];
    } else if (repeated) {
      classification = "DUPLICATE";
      reasons = ["same_window_external_id_duplicate"];
    } else if (product.previewStatus === "new" && product.reviewReasons.length === 0) {
      classification = "SAFE_NEW";
    } else if (product.previewStatus === "unchanged") {
      classification = "EXISTING_UNCHANGED";
    } else if (product.previewStatus === "update") {
      classification = "EXISTING_UPDATE";
    } else if (product.previewStatus === "duplicate"
      || product.reviewReasons.some((reason) => /duplicate|collision|ambiguous/.test(reason))) {
      classification = "DUPLICATE";
      reasons = product.reviewReasons;
    } else if (product.previewStatus === "needs_review") {
      classification = "NEEDS_REVIEW";
      reasons = product.reviewReasons;
    } else {
      classification = "INVALID";
      reasons = ["classification_unmapped"];
    }
    return {
      run_timestamp: runTimestamp,
      priority_position: candidate.priority_position,
      priority_lane: candidate.lane,
      priority_score: candidate.priority_score,
      priority_reason: candidate.reason,
      official_rank_position: candidate.official_rank_position,
      official_popularity_signal: candidate.official_popularity_signal,
      official_review_signal: candidate.official_review_signal,
      query_sorts: candidate.query_sorts,
      raw_source_sort: candidate.raw_source_sort,
      raw_source_position: candidate.raw_source_position,
      external_product_id: normalized.externalProductId,
      product_code: normalized.productCode,
      normalized_product_code: normalized.normalizedProductCode,
      release_date: normalized.releaseDate,
      payload_hash: payloadHash,
      actress_metadata_present: normalized.actressNames.length > 0,
      classification,
      reason_codes: reasons,
      raw_payload: rawPayload,
      normalized,
    };
  });
}

export async function buildPriorityFrozenRecords({ candidates, lookup, runTimestamp }) {
  const staged = await stageFanzaItems(candidates.map((candidate) => candidate.raw_payload), lookup);
  return {
    records: priorityFrozenRecordsFromStaged({ candidates, staged, runTimestamp }),
    staged,
  };
}

export function buildPriorityFrozenArtifacts(records) {
  if (!Array.isArray(records) || !records.length) throw new Error("PRIORITY_FROZEN_RECORDS_REQUIRED");
  const jsonl = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  return {
    jsonl,
    manifest_sha256: sha256(jsonl),
    membership_sha256: fanzaFrontierMembershipSha256(records),
    payload_sha256: fanzaFrontierPayloadMembershipSha256(records),
  };
}

export function priorityClassificationCounts(records) {
  return Object.fromEntries(CLASSIFICATIONS.map((classification) => [
    classification,
    records.filter((record) => record.classification === classification).length,
  ]));
}

export function buildPriorityFrozenSummary({
  records,
  artifacts,
  policyVersion,
  generatedAt,
  validUntil,
  asOf,
  laneCounts,
  metadataGets,
}) {
  const payloadHashVerifiedCount = records.filter((record) =>
    record.payload_hash === sha256(JSON.stringify(record.raw_payload))).length;
  return {
    status: "FROZEN",
    mode: "priority_lossless_freeze",
    policy_version: policyVersion,
    generated_at: generatedAt,
    valid_until: validUntil,
    as_of: asOf,
    candidate_total: records.length,
    lane_counts: laneCounts,
    classifications: priorityClassificationCounts(records),
    manifest_sha256: artifacts.manifest_sha256,
    membership_sha256: artifacts.membership_sha256,
    payload_sha256: artifacts.payload_sha256,
    payload_membership_sha256: artifacts.payload_sha256,
    raw_payload_count: records.filter((record) => record.raw_payload && typeof record.raw_payload === "object").length,
    normalized_count: records.filter((record) => record.normalized && typeof record.normalized === "object").length,
    payload_hash_verified_count: payloadHashVerifiedCount,
    provenance_conflicts: 0,
    api_metadata_get_count: metadataGets,
    duplicate_api_get: 0,
    image_get: 0,
    sample_get: 0,
    database_business_mutation: 0,
  };
}
