import type {
  CanonicalThumbnailPresentationResolution,
  LegacyCompatibilityThumbnailResolution,
  ThumbnailPresentationResolution,
} from "../src/lib/thumbnail/types.ts";

const legacy = {
  kind: "RESOLVED",
  resolution_kind: "LEGACY_COMPAT",
  canonical_code: "TYPELEGACY0001",
  mode: null,
  source_id: "videos.card_thumbnail_url",
  source_kind: "LEGACY_DB_URL",
  source_path_or_url: "/card-thumbnails/legacy.jpg",
  source_hash: null,
  output_path_or_url: "/card-thumbnails/legacy.jpg",
  output_hash: null,
  resolved_url: "/card-thumbnails/legacy.jpg",
  object_fit: "contain",
  crop_spec: null,
  approval_status: "UNREVIEWED",
  render_status: "READY",
  decision_source: "legacy_compatibility",
  reason: "LEGACY_UNCLASSIFIED_COMPATIBILITY",
  canonical_decision: null,
} as const satisfies LegacyCompatibilityThumbnailResolution;

const presentation: ThumbnailPresentationResolution = legacy;

// @ts-expect-error Legacy compatibility cannot be assigned as canonical.
const impossibleCanonical: CanonicalThumbnailPresentationResolution = legacy;

const impossibleLegacyApproval: LegacyCompatibilityThumbnailResolution = {
  ...legacy,
  // @ts-expect-error Legacy compatibility cannot claim human approval.
  approval_status: "HUMAN_APPROVED",
};

// @ts-expect-error URL-only legacy compatibility must not infer a canonical mode.
const impossibleDbMode: LegacyCompatibilityThumbnailResolution = {
  ...legacy,
  mode: "PACKAGE_RIGHT",
};

void presentation;
void impossibleCanonical;
void impossibleLegacyApproval;
void impossibleDbMode;
