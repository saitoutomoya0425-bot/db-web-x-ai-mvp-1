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
import {
  GENERATED_PHASE4C_REVIEWED_DECISION_RECORDS,
} from "./generated-phase4c-reviewed-decisions.ts";
import {
  GENERATED_PHASE4D_REVIEWED_DECISION_RECORDS,
} from "./generated-phase4d-reviewed-decisions.ts";
import {
  GENERATED_PHASE4E_REVIEWED_DECISION_RECORDS,
} from "./generated-phase4e-reviewed-decisions.ts";
import {
  GENERATED_PHASE5_REVIEWED_DECISION_RECORDS,
} from "./generated-phase5-reviewed-decisions.ts";
import type { CanonicalThumbnailDecision } from "./types.ts";

export const THUMBNAIL_PRODUCTION_REGISTRY_PRIORITY = Object.freeze([
  "fixed_canonical",
  "phase4e_reviewed",
  "phase4d_reviewed",
  "phase4c_reviewed",
  "generated_human",
  "generated_gold",
  "phase5_reviewed",
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
const phase4CReviewedDecisions = GENERATED_PHASE4C_REVIEWED_DECISION_RECORDS.map(
  (record) => adaptHumanApprovalRecord(record),
);
const phase4DReviewedDecisions = GENERATED_PHASE4D_REVIEWED_DECISION_RECORDS.map(
  (record) => adaptHumanApprovalRecord(record),
);
const phase4EReviewedDecisions = GENERATED_PHASE4E_REVIEWED_DECISION_RECORDS.map(
  (record) => adaptHumanApprovalRecord(record),
);
const generatedGoldDecisions = GENERATED_GOLD_DECISION_RECORDS.map((record) =>
  adaptGoldLabelRecord(record)
);
const phase5ReviewedDecisions = GENERATED_PHASE5_REVIEWED_DECISION_RECORDS.map(
  (record) => adaptHumanApprovalRecord(record),
);

const baseline = new Map<string, CanonicalThumbnailDecision>();
for (const decisions of [
  PRODUCTION_CANONICAL_THUMBNAIL_DECISIONS.values(),
  generatedHumanDecisions,
  generatedGoldDecisions,
]) {
  for (const decision of decisions) {
    if (!baseline.has(decision.code)) {
      baseline.set(decision.code, Object.freeze(decision));
    }
  }
}

export const PRODUCTION_BASELINE_THUMBNAIL_DECISIONS: ReadonlyMap<
  string,
  CanonicalThumbnailDecision
> = baseline;

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
    sources.get(decision.code) === "phase4e_reviewed" &&
    (source === "phase4d_reviewed" || source === "phase4c_reviewed")
  ) {
    // Phase 4E is the explicit latest user review. Keep the Phase 4C/4D rows as
    // immutable audit history while treating Phase 4E as their supersession.
    return;
  }
  if (
    sources.get(decision.code) === "phase4d_reviewed" &&
    source === "phase4c_reviewed"
  ) {
    // Phase 4D remains the later review for works without a Phase 4E decision.
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
for (const decision of phase4EReviewedDecisions) {
  mergeDecision(decision, "phase4e_reviewed");
}
for (const decision of phase4DReviewedDecisions) {
  mergeDecision(decision, "phase4d_reviewed");
}
for (const decision of phase4CReviewedDecisions) {
  mergeDecision(decision, "phase4c_reviewed");
}
for (const decision of generatedHumanDecisions) {
  mergeDecision(decision, "generated_human");
}
for (const decision of generatedGoldDecisions) {
  mergeDecision(decision, "generated_gold");
}
for (const decision of phase5ReviewedDecisions) {
  mergeDecision(decision, "phase5_reviewed");
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
