import { canonicalizeProductCodeValue } from "../fanza/normalize.ts";
import { getProductionCanonicalThumbnailDecision } from "./canonical-decisions.ts";
import {
  assertCanonicalThumbnailDecision,
  assertDecisionSourceApproval,
  assertModeContract,
  hasText,
  isTrustedThumbnailOutput,
  ThumbnailDecisionContractError,
  validateThumbnailResolution,
} from "./contract.ts";
import type {
  CanonicalThumbnailDecision,
  NonRenderableDecisionResolution,
  RenderableThumbnailResolution,
  ResolvedThumbnailDecision,
  ThumbnailDecisionSource,
  ThumbnailFallbackCandidate,
  ThumbnailResolutionInput,
} from "./types.ts";

export { ThumbnailDecisionContractError } from "./contract.ts";
export { isRenderableThumbnailResolution } from "./contract.ts";

export const THUMBNAIL_DECISION_PRIORITY = [
  "production_canonical",
  "human_decision",
  "gold_label",
  "local_generated_asset",
  "database_url",
  "external_fallback",
] as const satisfies readonly Exclude<ThumbnailDecisionSource, "none">[];

const contractError = (message: string): never => {
  throw new ThumbnailDecisionContractError(message);
};

function validateDecisionForSlot(
  requestedCode: string,
  decision: CanonicalThumbnailDecision,
  source:
    | "production_canonical"
    | "human_decision"
    | "gold_label"
    | "local_generated_asset",
) {
  const validated = assertCanonicalThumbnailDecision(decision);
  if (validated.code !== requestedCode) {
    contractError(
      `decision code mismatch: requested=${requestedCode} decision=${validated.code}`,
    );
  }
  if (source !== "production_canonical") {
    assertDecisionSourceApproval(source, validated.approval_status);
  }
  return validated;
}

function resolvedFromCanonical(
  decision: CanonicalThumbnailDecision,
  source:
    | "production_canonical"
    | "human_decision"
    | "gold_label"
    | "local_generated_asset",
): RenderableThumbnailResolution | NonRenderableDecisionResolution {
  if (decision.kind === "RESOLVED") {
    return {
      ...decision,
      kind: "RESOLVED",
      canonical_code: decision.code,
      resolved_url: decision.output_path_or_url,
      decision_source: source,
      canonical_decision: decision,
    };
  }
  if (decision.kind === "PENDING_SOURCE") {
    return {
      ...decision,
      canonical_code: decision.code,
      resolved_url: null,
      decision_source: source,
      canonical_decision: decision,
    };
  }
  if (decision.kind === "PENDING_OUTPUT") {
    return {
      ...decision,
      canonical_code: decision.code,
      resolved_url: null,
      decision_source: source,
      canonical_decision: decision,
    };
  }
  return {
    ...decision,
    canonical_code: decision.code,
    resolved_url: null,
    decision_source: source,
    canonical_decision: decision,
  };
}

function resolvedFromFallback(
  code: string,
  candidate: ThumbnailFallbackCandidate,
  source: "database_url" | "external_fallback",
): RenderableThumbnailResolution | null {
  if (candidate.url === null) return null;
  if (!hasText(candidate.source_id)) contractError(`${source} requires source_id`);
  if (!hasText(candidate.source_path_or_url)) {
    contractError(`${source} requires source_path_or_url`);
  }
  if (!hasText(candidate.reason)) contractError(`${source} requires a reason`);
  if (!isTrustedThumbnailOutput(candidate.url)) {
    contractError(`${source} requires a trusted image URL`);
  }
  if (source === "external_fallback" && !candidate.url.trim().startsWith("https://")) {
    contractError("external_fallback requires an HTTPS URL");
  }
  const runtimeMode: unknown = candidate.mode;
  if (runtimeMode === "SCENE_CROP") {
    contractError("SCENE_CROP cannot be selected from a fallback source");
  }
  assertModeContract({
    mode: candidate.mode,
    source_kind: candidate.source_kind,
    source_id: candidate.source_id,
    object_fit: candidate.object_fit,
    crop_spec: candidate.crop_spec,
  });

  return {
    ...candidate,
    kind: "RESOLVED",
    canonical_code: code,
    source_id: candidate.source_id.trim(),
    source_path_or_url: candidate.source_path_or_url.trim(),
    source_hash: null,
    output_path_or_url: candidate.url.trim(),
    resolved_url: candidate.url.trim(),
    output_hash: null,
    approval_status: "UNREVIEWED",
    render_status: "READY",
    decision_source: source,
    reason: candidate.reason.trim(),
    canonical_decision: null,
  };
}

const sourceMissing = (
  code: string,
  reason: string,
): ResolvedThumbnailDecision => ({
  kind: "SOURCE_MISSING",
  canonical_code: code,
  mode: null,
  source_id: null,
  source_kind: null,
  source_path_or_url: null,
  source_hash: null,
  output_path_or_url: null,
  resolved_url: null,
  output_hash: null,
  object_fit: null,
  crop_spec: null,
  approval_status: null,
  render_status: null,
  decision_source: "none",
  reason,
  canonical_decision: null,
});

const invalidCode = (reason: string): ResolvedThumbnailDecision => ({
  kind: "INVALID_CODE",
  canonical_code: null,
  mode: null,
  source_id: null,
  source_kind: null,
  source_path_or_url: null,
  source_hash: null,
  output_path_or_url: null,
  resolved_url: null,
  output_hash: null,
  object_fit: null,
  crop_spec: null,
  approval_status: null,
  render_status: null,
  decision_source: "none",
  reason,
  canonical_decision: null,
});

export function resolveCanonicalThumbnail(
  input: ThumbnailResolutionInput,
): ResolvedThumbnailDecision {
  const normalizedCode = canonicalizeProductCodeValue(input.code);
  if (normalizedCode.rejected) {
    return validateThumbnailResolution(
      invalidCode(normalizedCode.rejectionReason ?? "product code is rejected"),
    );
  }
  if (!normalizedCode.canonical) {
    return validateThumbnailResolution(
      invalidCode("A canonical product code is required"),
    );
  }
  const requestedCode = normalizedCode.canonical;
  const productionDecision = getProductionCanonicalThumbnailDecision(requestedCode);

  for (const source of THUMBNAIL_DECISION_PRIORITY) {
    if (source === "production_canonical") {
      if (!productionDecision) continue;
      const decision = validateDecisionForSlot(requestedCode, productionDecision, source);
      return validateThumbnailResolution(resolvedFromCanonical(decision, source));
    }
    if (
      source === "human_decision" ||
      source === "gold_label" ||
      source === "local_generated_asset"
    ) {
      const rawDecision = input[source];
      if (!rawDecision) continue;
      const decision = validateDecisionForSlot(requestedCode, rawDecision, source);
      return validateThumbnailResolution(resolvedFromCanonical(decision, source));
    }

    const fallback = input[source];
    if (!fallback) continue;
    const resolved = resolvedFromFallback(requestedCode, fallback, source);
    if (resolved) return validateThumbnailResolution(resolved);
  }

  return validateThumbnailResolution(sourceMissing(
    requestedCode,
    "No canonical, human, gold, local, database, or external thumbnail source is available",
  ));
}
