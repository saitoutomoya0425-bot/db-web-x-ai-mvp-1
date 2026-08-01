import { canonicalizeProductCodeValue } from "../fanza/normalize.ts";
import {
  GENERATED_PHASE4B_LEGACY_RECORDS,
  GENERATED_PHASE4B_LEGACY_STATS,
} from "./generated-phase4b-legacy-registry.ts";
import {
  hasText,
  isTrustedThumbnailOutput,
  modeContract,
  ThumbnailDecisionContractError,
} from "./contract.ts";
import type {
  Phase4BLegacyThumbnailRecord,
  ThumbnailMode,
} from "./types.ts";

const EXPECTED_TOTAL = 796;
const EXPECTED_MODE_COUNTS = Object.freeze({
  SAMPLE: 129,
  PACKAGE_RIGHT: 410,
  PACKAGE_CENTER: 141,
  PACKAGE_FULL: 116,
});

function invalid(message: string): never {
  throw new ThumbnailDecisionContractError(`Phase 4B registry: ${message}`);
}

function validateRecord(value: unknown): Phase4BLegacyThumbnailRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid("record must be an object");
  }
  const record = value as Record<string, unknown>;
  const normalized = canonicalizeProductCodeValue(record.code);
  if (
    !normalized.canonical ||
    normalized.rejected ||
    normalized.canonical !== record.code
  ) {
    return invalid(`invalid canonical code ${String(record.code)}`);
  }
  if (
    record.mode !== "SAMPLE" &&
    record.mode !== "PACKAGE_RIGHT" &&
    record.mode !== "PACKAGE_CENTER" &&
    record.mode !== "PACKAGE_FULL"
  ) {
    return invalid(`${record.code} has an unsupported mode`);
  }
  const mode = record.mode as ThumbnailMode;
  if (
    !hasText(record.source_id) ||
    !new RegExp(modeContract(mode).source_id_pattern).test(record.source_id)
  ) {
    return invalid(`${record.code} has an invalid source_id`);
  }
  if (
    !isTrustedThumbnailOutput(record.resolved_url) ||
    record.object_fit !== modeContract(mode).object_fit ||
    record.object_position !== (mode === "PACKAGE_RIGHT" ? "right" : "center")
  ) {
    return invalid(`${record.code} has an invalid render contract`);
  }
  if (
    record.render_strategy !== "AUDIT_OUTPUT" &&
    record.render_strategy !== "CSS_PACKAGE_POSITION"
  ) {
    return invalid(`${record.code} has an invalid render strategy`);
  }
  if (
    record.render_strategy === "CSS_PACKAGE_POSITION" &&
    (mode !== "PACKAGE_RIGHT" && mode !== "PACKAGE_CENTER")
  ) {
    return invalid(`${record.code} cannot use CSS package positioning`);
  }
  return Object.freeze(record) as Phase4BLegacyThumbnailRecord;
}

const records = new Map<string, Phase4BLegacyThumbnailRecord>();
const modeCounts: Record<string, number> = {};
for (const raw of GENERATED_PHASE4B_LEGACY_RECORDS) {
  const record = validateRecord(raw);
  if (records.has(record.code)) invalid(`duplicate code ${record.code}`);
  records.set(record.code, record);
  modeCounts[record.mode] = (modeCounts[record.mode] ?? 0) + 1;
}
if (records.size !== EXPECTED_TOTAL) invalid(`expected ${EXPECTED_TOTAL} records`);
for (const [mode, expected] of Object.entries(EXPECTED_MODE_COUNTS)) {
  if (modeCounts[mode] !== expected) invalid(`${mode} count must be ${expected}`);
}
if (
  GENERATED_PHASE4B_LEGACY_STATS.total !== EXPECTED_TOTAL ||
  GENERATED_PHASE4B_LEGACY_STATS.SCENE_CROP !== 0 ||
  GENERATED_PHASE4B_LEGACY_STATS.human_review_excluded !== 125
) {
  invalid("generated statistics do not match the runtime contract");
}

export const PHASE4B_LEGACY_THUMBNAIL_DECISIONS: ReadonlyMap<
  string,
  Phase4BLegacyThumbnailRecord
> = records;

export { GENERATED_PHASE4B_LEGACY_STATS as PHASE4B_LEGACY_REGISTRY_STATS };

export function getPhase4BLegacyThumbnailDecision(
  code: unknown,
): Phase4BLegacyThumbnailRecord | null {
  const normalized = canonicalizeProductCodeValue(code);
  if (!normalized.canonical || normalized.rejected) return null;
  return records.get(normalized.canonical) ?? null;
}
