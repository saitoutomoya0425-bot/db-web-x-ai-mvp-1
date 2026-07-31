import { canonicalizeProductCodeValue } from "../fanza/normalize.ts";
import {
  adaptGoldLabelRecord,
  adaptHumanApprovalRecord,
} from "./adapters.ts";
import { PRODUCTION_CANONICAL_THUMBNAIL_DECISIONS } from "./canonical-decisions.ts";
import {
  GENERATED_GOLD_DECISION_RECORDS,
  GENERATED_HUMAN_DECISION_RECORDS,
} from "./generated-approved-decisions.ts";
import type { CanonicalThumbnailDecision } from "./types.ts";

export const THUMBNAIL_PRODUCTION_REGISTRY_PRIORITY = Object.freeze([
  "fixed_canonical",
  "generated_human",
  "generated_gold",
] as const);

type RegistrySource = (typeof THUMBNAIL_PRODUCTION_REGISTRY_PRIORITY)[number];

type RegistryConflict = {
  readonly code: string;
  readonly kept: RegistrySource;
  readonly ignored: RegistrySource;
  readonly kept_mode: CanonicalThumbnailDecision["mode"];
  readonly ignored_mode: CanonicalThumbnailDecision["mode"];
  readonly kept_source_id: string | null;
  readonly ignored_source_id: string | null;
};

const generatedHumanDecisions = GENERATED_HUMAN_DECISION_RECORDS.map((record) =>
  adaptHumanApprovalRecord(record)
);
const generatedGoldDecisions = GENERATED_GOLD_DECISION_RECORDS.map((record) =>
  adaptGoldLabelRecord(record)
);

const combined = new Map<string, CanonicalThumbnailDecision>();
const sources = new Map<string, RegistrySource>();
const conflicts: RegistryConflict[] = [];

function mergeDecision(
  decision: CanonicalThumbnailDecision,
  source: RegistrySource,
) {
  const existing = combined.get(decision.code);
  if (!existing) {
    combined.set(decision.code, Object.freeze(decision));
    sources.set(decision.code, source);
    return;
  }
  if (
    existing.mode !== decision.mode ||
    existing.source_id !== decision.source_id ||
    existing.kind !== decision.kind ||
    existing.output_path_or_url !== decision.output_path_or_url
  ) {
    conflicts.push(Object.freeze({
      code: decision.code,
      kept: sources.get(decision.code) ?? "fixed_canonical",
      ignored: source,
      kept_mode: existing.mode,
      ignored_mode: decision.mode,
      kept_source_id: existing.source_id,
      ignored_source_id: decision.source_id,
    }));
  }
}

for (const decision of PRODUCTION_CANONICAL_THUMBNAIL_DECISIONS.values()) {
  mergeDecision(decision, "fixed_canonical");
}
for (const decision of generatedHumanDecisions) {
  mergeDecision(decision, "generated_human");
}
for (const decision of generatedGoldDecisions) {
  mergeDecision(decision, "generated_gold");
}

export const PRODUCTION_THUMBNAIL_DECISIONS: ReadonlyMap<
  string,
  CanonicalThumbnailDecision
> = combined;

export const PRODUCTION_THUMBNAIL_REGISTRY_CONFLICTS: readonly RegistryConflict[] =
  Object.freeze(conflicts);

export function getProductionThumbnailDecision(
  code: unknown,
): CanonicalThumbnailDecision | null {
  const canonical = canonicalizeProductCodeValue(code);
  if (!canonical.canonical || canonical.rejected) return null;
  return PRODUCTION_THUMBNAIL_DECISIONS.get(canonical.canonical) ?? null;
}
