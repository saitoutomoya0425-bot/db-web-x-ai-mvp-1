import { canonicalizeProductCodeValue } from "../fanza/normalize.ts";
import { getProductionThumbnailDecision } from "./production-registry.ts";
import { getPhase4BLegacyThumbnailDecision } from "./phase4b-legacy-registry.ts";
import {
  hasText,
  isTrustedThumbnailOutput,
  modeContract,
  ThumbnailDecisionContractError,
  validateThumbnailResolution,
} from "./contract.ts";
import { resolveCanonicalThumbnail } from "./resolver.ts";
import {
  THUMBNAIL_MODES,
  type LegacyCompatibilityThumbnailResolution,
  type LegacyRuntimeThumbnailOverride,
  type Phase4BLegacyThumbnailRecord,
  type NonRenderableThumbnailPresentationResolution,
  type ThumbnailMode,
  type ThumbnailPresentationInput,
  type ThumbnailPresentationResolution,
  type ThumbnailRenderContract,
} from "./types.ts";

export const THUMBNAIL_PRESENTATION_PRIORITY = Object.freeze([
  "canonical_decision",
  "phase4b_explicit_legacy",
  "legacy_runtime_override",
  "legacy_card_url",
  "legacy_thumbnail_url",
  "placeholder",
] as const);

const SHA256 = /^[a-f0-9]{64}$/i;
const LEGACY_DB_SOURCE_IDS = Object.freeze({
  legacy_card_url: "videos.card_thumbnail_url",
  legacy_thumbnail_url: "videos.thumbnail_url",
} as const);

const LEGACY_MODE_ALIASES: Readonly<Record<string, ThumbnailMode>> =
  Object.freeze({
    full: "PACKAGE_FULL",
    package_full: "PACKAGE_FULL",
    right: "PACKAGE_RIGHT",
    package_right: "PACKAGE_RIGHT",
    center: "PACKAGE_CENTER",
    package_center: "PACKAGE_CENTER",
    sample: "SAMPLE",
    scene_full: "SCENE_FULL",
  });

const contractError = (message: string): never => {
  throw new ThumbnailDecisionContractError(message);
};

function explicitLegacyMode(value: unknown): ThumbnailMode | null {
  if (!hasText(value)) return null;
  const normalized = value.trim().toLowerCase();
  const aliased = LEGACY_MODE_ALIASES[normalized];
  if (aliased) return aliased;
  const upper = value.trim().toUpperCase();
  return THUMBNAIL_MODES.includes(upper as ThumbnailMode)
    ? upper as ThumbnailMode
    : null;
}

function assertLegacyModeSourceId(mode: ThumbnailMode | null, sourceId: string) {
  if (mode === null) return;
  if (mode === "SCENE_CROP") {
    contractError(
      "legacy compatibility cannot authorize SCENE_CROP without a canonical work-level approval",
    );
  }
  if (!new RegExp(modeContract(mode).source_id_pattern).test(sourceId)) {
    contractError(`legacy ${mode} has an invalid source_id`);
  }
}

export function validateLegacyCompatibilityResolution(
  resolution: unknown,
): LegacyCompatibilityThumbnailResolution {
  if (!resolution || typeof resolution !== "object") {
    contractError("legacy compatibility resolution must be an object");
  }
  const candidate = resolution as Record<string, unknown>;
  const canonical = canonicalizeProductCodeValue(candidate.canonical_code);
  if (
    !canonical.canonical ||
    canonical.rejected ||
    canonical.canonical !== candidate.canonical_code
  ) {
    contractError("legacy compatibility requires a canonical code");
  }
  if (
    candidate.kind !== "RESOLVED" ||
    candidate.resolution_kind !== "LEGACY_COMPAT" ||
    candidate.approval_status !== "UNREVIEWED" ||
    candidate.render_status !== "READY" ||
    candidate.decision_source !== "legacy_compatibility" ||
    candidate.canonical_decision !== null
  ) {
    contractError("legacy compatibility has invalid state");
  }
  if (
    candidate.source_kind !== "LEGACY_RUNTIME_OVERRIDE" &&
    candidate.source_kind !== "PHASE4B_EXPLICIT_LEGACY" &&
    candidate.source_kind !== "LEGACY_DB_URL"
  ) {
    contractError("legacy compatibility has an invalid source_kind");
  }
  const sourceId = candidate.source_id;
  if (typeof sourceId !== "string" || !sourceId.trim()) {
    throw new ThumbnailDecisionContractError(
      "legacy compatibility requires source_id",
    );
  }
  const normalizedSourceId = sourceId.trim();
  if (
    !hasText(candidate.reason) ||
    candidate.crop_spec !== null
  ) {
    contractError("legacy compatibility must have a reason and no crop");
  }
  if (
    !isTrustedThumbnailOutput(candidate.resolved_url) ||
    candidate.source_path_or_url !== candidate.resolved_url ||
    candidate.output_path_or_url !== candidate.resolved_url
  ) {
    contractError("legacy compatibility requires one trusted resolved URL");
  }
  if (candidate.source_hash !== null) {
    contractError("legacy compatibility cannot invent a source hash");
  }
  if (
    candidate.output_hash !== null &&
    (!hasText(candidate.output_hash) || !SHA256.test(candidate.output_hash))
  ) {
    contractError("legacy compatibility output_hash must be null or SHA-256");
  }

  const mode =
    candidate.mode === null
      ? null
      : THUMBNAIL_MODES.includes(candidate.mode as ThumbnailMode)
        ? candidate.mode as ThumbnailMode
        : contractError("legacy compatibility has an invalid mode");

  if (candidate.source_kind === "LEGACY_DB_URL") {
    if (
      mode !== null ||
      candidate.object_fit !== "contain" ||
      !Object.values(LEGACY_DB_SOURCE_IDS).includes(
        normalizedSourceId as (typeof LEGACY_DB_SOURCE_IDS)[keyof typeof LEGACY_DB_SOURCE_IDS],
      ) ||
      candidate.output_hash !== null
    ) {
      contractError(
        "legacy DB URL must remain unclassified and cannot claim an output hash",
      );
    }
  } else if (candidate.source_kind === "PHASE4B_EXPLICIT_LEGACY") {
    if (
      mode === null ||
      mode === "SCENE_CROP" ||
      mode === "SCENE_FULL" ||
      candidate.object_fit !== modeContract(mode).object_fit ||
      candidate.object_position !== (mode === "PACKAGE_RIGHT" ? "right" : "center") ||
      candidate.output_hash !== null
    ) {
      contractError("Phase 4B legacy selection has an invalid render contract");
    }
    assertLegacyModeSourceId(mode, normalizedSourceId);
  } else {
    if (candidate.object_fit !== "contain") {
      contractError("legacy runtime override must render with contain");
    }
    assertLegacyModeSourceId(mode, normalizedSourceId);
  }

  return resolution as LegacyCompatibilityThumbnailResolution;
}

function phase4BLegacyResolution(
  code: string,
  record: Phase4BLegacyThumbnailRecord,
) {
  return validateLegacyCompatibilityResolution({
    kind: "RESOLVED",
    resolution_kind: "LEGACY_COMPAT",
    canonical_code: code,
    mode: record.mode,
    source_id: record.source_id,
    source_kind: "PHASE4B_EXPLICIT_LEGACY",
    source_path_or_url: record.resolved_url,
    source_hash: null,
    output_path_or_url: record.resolved_url,
    output_hash: null,
    resolved_url: record.resolved_url,
    object_fit: record.object_fit,
    object_position: record.object_position,
    crop_spec: null,
    approval_status: "UNREVIEWED",
    render_status: "READY",
    decision_source: "legacy_compatibility",
    reason: "PHASE4B_AUDITED_EXPLICIT_LEGACY_COMPATIBILITY",
    canonical_decision: null,
  });
}

function legacyRuntimeResolution(
  code: string,
  override: LegacyRuntimeThumbnailOverride,
) {
  if (!hasText(override.path) || !isTrustedThumbnailOutput(override.path)) {
    contractError("legacy runtime override requires a trusted path");
  }
  if (!hasText(override.source_id)) {
    contractError("legacy runtime override requires an explicit source_id");
  }
  const mode = explicitLegacyMode(override.mode);
  if (hasText(override.mode) && mode === null) {
    contractError("legacy runtime override has an unsupported explicit mode");
  }
  assertLegacyModeSourceId(mode, override.source_id.trim());
  return validateLegacyCompatibilityResolution({
    kind: "RESOLVED",
    resolution_kind: "LEGACY_COMPAT",
    canonical_code: code,
    mode,
    source_id: override.source_id.trim(),
    source_kind: "LEGACY_RUNTIME_OVERRIDE",
    source_path_or_url: override.path.trim(),
    source_hash: null,
    output_path_or_url: override.path.trim(),
    output_hash: override.output_hash,
    resolved_url: override.path.trim(),
    object_fit: "contain",
    crop_spec: null,
    approval_status: "UNREVIEWED",
    render_status: "READY",
    decision_source: "legacy_compatibility",
    reason: "LEGACY_EXPLICIT_RUNTIME_OVERRIDE_COMPATIBILITY",
    canonical_decision: null,
  });
}

function legacyDatabaseResolution(
  code: string,
  value: unknown,
  source: keyof typeof LEGACY_DB_SOURCE_IDS,
) {
  if (!hasText(value)) return null;
  const resolvedUrl = value.trim();
  if (!isTrustedThumbnailOutput(resolvedUrl)) {
    contractError(`${LEGACY_DB_SOURCE_IDS[source]} contains an untrusted URL`);
  }
  return validateLegacyCompatibilityResolution({
    kind: "RESOLVED",
    resolution_kind: "LEGACY_COMPAT",
    canonical_code: code,
    mode: null,
    source_id: LEGACY_DB_SOURCE_IDS[source],
    source_kind: "LEGACY_DB_URL",
    source_path_or_url: resolvedUrl,
    source_hash: null,
    output_path_or_url: resolvedUrl,
    output_hash: null,
    resolved_url: resolvedUrl,
    object_fit: "contain",
    crop_spec: null,
    approval_status: "UNREVIEWED",
    render_status: "READY",
    decision_source: "legacy_compatibility",
    reason: "LEGACY_UNCLASSIFIED_COMPATIBILITY",
    canonical_decision: null,
  });
}

function nonRenderable(
  input: ThumbnailPresentationInput,
): NonRenderableThumbnailPresentationResolution {
  const resolution = resolveCanonicalThumbnail({
    code: input.code,
    human_decision: input.human_decision,
    gold_label: input.gold_label,
    local_generated_asset: input.local_generated_asset,
  });
  if (resolution.kind === "SOURCE_MISSING" || resolution.kind === "INVALID_CODE") {
    return {
      ...resolution,
      resolution_kind: "NON_RENDERABLE",
    };
  }
  return contractError("expected a non-renderable terminal resolution");
}

function invalidLegacyPlaceholder(
  input: ThumbnailPresentationInput,
  reason: string,
): NonRenderableThumbnailPresentationResolution {
  const terminal = nonRenderable(input);
  if (terminal.kind === "INVALID_CODE") return terminal;
  return validateThumbnailPresentationResolution({
    ...terminal,
    reason,
  }) as NonRenderableThumbnailPresentationResolution;
}

export function validateThumbnailPresentationResolution(
  resolution: unknown,
): ThumbnailPresentationResolution {
  if (!resolution || typeof resolution !== "object") {
    contractError("thumbnail presentation resolution must be an object");
  }
  const candidate = resolution as Record<string, unknown>;
  if (candidate.resolution_kind === "LEGACY_COMPAT") {
    return validateLegacyCompatibilityResolution(resolution);
  }
  if (
    candidate.resolution_kind !== "CANONICAL" &&
    candidate.resolution_kind !== "NON_RENDERABLE"
  ) {
    contractError("thumbnail presentation requires a resolution_kind");
  }
  const { resolution_kind: _resolutionKind, ...base } = candidate;
  const validated = validateThumbnailResolution(base);
  if (candidate.resolution_kind === "CANONICAL") {
    if (validated.canonical_decision === null) {
      contractError("CANONICAL presentation requires a canonical decision");
    }
  } else if (
    validated.kind !== "SOURCE_MISSING" &&
    validated.kind !== "INVALID_CODE"
  ) {
    contractError("NON_RENDERABLE presentation requires a terminal state");
  }
  return resolution as ThumbnailPresentationResolution;
}

export function resolveThumbnailPresentation(
  input: ThumbnailPresentationInput,
): ThumbnailPresentationResolution {
  const normalized = canonicalizeProductCodeValue(input.code);
  if (normalized.rejected || !normalized.canonical) {
    return validateThumbnailPresentationResolution(nonRenderable(input));
  }
  const code = normalized.canonical;
  const hasCanonicalDecision = Boolean(
    getProductionThumbnailDecision(code) ||
      input.human_decision ||
      input.gold_label ||
      input.local_generated_asset,
  );

  if (hasCanonicalDecision) {
    if (input.canonical_lookup_outcome) {
      contractError(
        "canonical decision conflicts with an explicit SOURCE_MISSING outcome",
      );
    }
    const canonical = resolveCanonicalThumbnail({
      code,
      human_decision: input.human_decision,
      gold_label: input.gold_label,
      local_generated_asset: input.local_generated_asset,
    });
    if (canonical.kind === "SOURCE_MISSING" || canonical.kind === "INVALID_CODE") {
      contractError("an explicit canonical decision cannot resolve as missing");
    }
    return validateThumbnailPresentationResolution({
      ...canonical,
      resolution_kind: "CANONICAL",
    });
  }

  if (input.canonical_lookup_outcome) {
    if (!hasText(input.canonical_lookup_outcome.reason)) {
      contractError("explicit canonical SOURCE_MISSING requires a reason");
    }
    return invalidLegacyPlaceholder(
      input,
      input.canonical_lookup_outcome.reason.trim(),
    );
  }

  const phase4BDecision = getPhase4BLegacyThumbnailDecision(code);
  if (phase4BDecision) {
    return phase4BLegacyResolution(code, phase4BDecision);
  }

  const runtimeOverride = input.legacy_runtime_override;
  if (runtimeOverride) {
    try {
      return legacyRuntimeResolution(code, runtimeOverride);
    } catch (error) {
      if (!(error instanceof ThumbnailDecisionContractError)) throw error;
      return invalidLegacyPlaceholder(
        input,
        "Legacy runtime override failed validation",
      );
    }
  }

  let card: LegacyCompatibilityThumbnailResolution | null;
  try {
    card = legacyDatabaseResolution(
      code,
      input.legacy_card_url,
      "legacy_card_url",
    );
  } catch (error) {
    if (!(error instanceof ThumbnailDecisionContractError)) throw error;
    return invalidLegacyPlaceholder(
      input,
      "Legacy card URL failed validation",
    );
  }
  if (card) return card;
  let thumbnail: LegacyCompatibilityThumbnailResolution | null;
  try {
    thumbnail = legacyDatabaseResolution(
      code,
      input.legacy_thumbnail_url,
      "legacy_thumbnail_url",
    );
  } catch (error) {
    if (!(error instanceof ThumbnailDecisionContractError)) throw error;
    return invalidLegacyPlaceholder(
      input,
      "Legacy thumbnail URL failed validation",
    );
  }
  if (thumbnail) return thumbnail;

  return validateThumbnailPresentationResolution(nonRenderable({ ...input, code }));
}

export function buildThumbnailRenderContract(
  resolution: ThumbnailPresentationResolution,
): ThumbnailRenderContract {
  const validated = validateThumbnailPresentationResolution(resolution);
  const renderable =
    validated.kind === "RESOLVED" &&
    validated.render_status === "READY" &&
    isTrustedThumbnailOutput(validated.resolved_url);
  return {
    src: renderable ? validated.resolved_url : null,
    object_fit: renderable ? validated.object_fit : null,
    object_position: renderable
      ? validated.resolution_kind === "LEGACY_COMPAT" &&
          validated.source_kind === "PHASE4B_EXPLICIT_LEGACY"
        ? validated.object_position
        : "center"
      : null,
    crop_spec: renderable ? validated.crop_spec : null,
    attributes: {
      code: validated.canonical_code,
      resolution_kind: validated.resolution_kind,
      mode:
        validated.resolution_kind === "LEGACY_COMPAT" && validated.mode === null
          ? "LEGACY_UNCLASSIFIED"
          : validated.mode,
      source_id: validated.source_id,
      approval_status: validated.approval_status,
      render_status: validated.render_status,
    },
    reason: validated.reason,
  };
}

export function resolvedThumbnailUrl(
  resolution: ThumbnailPresentationResolution,
) {
  return buildThumbnailRenderContract(resolution).src;
}

export type StoredThumbnailPresentationSnapshot = {
  readonly resolution_kind:
    | "CANONICAL"
    | "LEGACY_COMPAT"
    | "NON_RENDERABLE";
  readonly canonical_code: string | null;
  readonly mode: ThumbnailMode | "LEGACY_UNCLASSIFIED" | null;
  readonly source_id: string | null;
  readonly approval_status: string | null;
  readonly render_status: string | null;
  readonly resolved_url: string | null;
};

export function toStoredThumbnailPresentationSnapshot(
  resolution: ThumbnailPresentationResolution,
): StoredThumbnailPresentationSnapshot {
  const contract = buildThumbnailRenderContract(resolution);
  return {
    resolution_kind: contract.attributes.resolution_kind,
    canonical_code: contract.attributes.code,
    mode: contract.attributes.mode,
    source_id: contract.attributes.source_id,
    approval_status: contract.attributes.approval_status,
    render_status: contract.attributes.render_status,
    resolved_url: contract.src,
  };
}
