import { createHash } from "node:crypto";
import { fanzaSafetyReviewReasons } from "../../src/lib/fanza/pipeline.ts";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function frozenSafeNewProvenanceIssues(candidate) {
  const issues = [];
  const externalProductId = candidate?.external_product_id ?? "unknown";
  const rawPayloadValid = candidate?.raw_payload
    && typeof candidate.raw_payload === "object"
    && !Array.isArray(candidate.raw_payload);
  const normalizedValid = candidate?.normalized
    && typeof candidate.normalized === "object"
    && !Array.isArray(candidate.normalized);

  if (candidate?.classification !== "SAFE_NEW") issues.push(`${externalProductId}:classification`);
  if (!rawPayloadValid) issues.push(`${externalProductId}:raw_payload`);
  if (!normalizedValid) issues.push(`${externalProductId}:normalized`);
  if (rawPayloadValid && candidate?.payload_hash !== sha256(JSON.stringify(candidate.raw_payload))) {
    issues.push(`${externalProductId}:payload_hash`);
  }
  if (normalizedValid && candidate.normalized.externalProductId !== candidate.external_product_id) {
    issues.push(`${externalProductId}:external_id`);
  }
  if (normalizedValid && candidate.normalized.normalizedProductCode !== candidate.normalized_product_code) {
    issues.push(`${externalProductId}:normalized_code`);
  }
  if (!candidate?.actress_metadata_present
    || !normalizedValid
    || !Array.isArray(candidate.normalized.actressNames)
    || candidate.normalized.actressNames.length < 1) {
    issues.push(`${externalProductId}:actress`);
  }
  if (normalizedValid) {
    const safetyReasons = fanzaSafetyReviewReasons(candidate.normalized);
    if (safetyReasons.length) issues.push(`${externalProductId}:${safetyReasons.join(",")}`);
  }
  return issues;
}

export function assertFrozenSafeNewProvenance(candidate) {
  const issues = frozenSafeNewProvenanceIssues(candidate);
  if (issues.length) throw new Error(`FROZEN_PROVENANCE_INCOMPLETE_${issues.length}`);
  return candidate;
}
