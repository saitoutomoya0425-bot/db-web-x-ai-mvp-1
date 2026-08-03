import type {
  CanonicalThumbnailDecision,
  ThumbnailFallbackCandidate,
} from "../src/lib/thumbnail/types.ts";

const resolvedBase = {
  kind: "RESOLVED",
  code: "TYPECHECK0001",
  source_path_or_url: "/source.jpg",
  source_hash: "a".repeat(64),
  output_path_or_url: "/card-thumbnails/output.jpg",
  output_hash: "b".repeat(64),
  approval_status: "HUMAN_APPROVED",
  render_status: "READY",
  approved_by: "USER_HANDOFF",
  approved_at: "2026-07-29",
  reason: "type contract check",
} as const;

const validSample = {
  ...resolvedBase,
  mode: "SAMPLE",
  source_id: "sample:1",
  source_kind: "SAMPLE",
  object_fit: "scale-down",
  crop_spec: null,
} satisfies CanonicalThumbnailDecision;

void validSample;

const validModeApprovedFull = {
  ...resolvedBase,
  mode: "PACKAGE_FULL",
  source_id: "dvd:full",
  source_kind: "PACKAGE",
  object_fit: "contain",
  crop_spec: null,
  approval_status: "MODE_APPROVED",
} satisfies CanonicalThumbnailDecision;

void validModeApprovedFull;

// @ts-expect-error SAMPLE cannot use PACKAGE source metadata.
const impossibleSamplePackage: CanonicalThumbnailDecision = {
  ...resolvedBase,
  mode: "SAMPLE",
  source_id: "dvd:right",
  source_kind: "PACKAGE",
  object_fit: "scale-down",
  crop_spec: null,
};

const impossibleSourceMissing: CanonicalThumbnailDecision = {
  ...resolvedBase,
  // @ts-expect-error SOURCE_MISSING is a resolution state, not a canonical decision.
  kind: "SOURCE_MISSING",
  mode: "PACKAGE_RIGHT",
  source_id: null,
  source_kind: "PACKAGE",
  object_fit: "cover",
  crop_spec: null,
  approval_status: "HUMAN_APPROVED",
  render_status: "READY",
};

// @ts-expect-error fallback render contracts require mode and object_fit.
const incompleteFallback: ThumbnailFallbackCandidate = {
  source_id: "dvd:right",
  source_kind: "PACKAGE",
  source_path_or_url: "/source.jpg",
  url: "/card-thumbnails/output.jpg",
  crop_spec: null,
  reason: "missing mode and object_fit",
};

// @ts-expect-error HUMAN_APPROVED requires a concrete approver.
const impossibleHumanWithoutApprover: CanonicalThumbnailDecision = {
  ...validSample,
  approved_by: null,
};

// @ts-expect-error SCENE_CROP can only be HUMAN_APPROVED.
const impossibleGoldSceneCrop: CanonicalThumbnailDecision = {
  ...resolvedBase,
  mode: "SCENE_CROP",
  source_id: "scene:1",
  source_kind: "SCENE",
  object_fit: "scale-down",
  crop_spec: { unit: "ratio", x: 0, y: 0, width: 1, height: 1 },
  approval_status: "GOLD_APPROVED",
};

// @ts-expect-error SCENE_CROP cannot be MODE_APPROVED.
const impossibleModeApprovedSceneCrop: CanonicalThumbnailDecision = {
  ...resolvedBase,
  mode: "SCENE_CROP",
  source_id: "scene:1",
  source_kind: "SCENE",
  object_fit: "scale-down",
  crop_spec: { unit: "ratio", x: 0, y: 0, width: 1, height: 1 },
  approval_status: "MODE_APPROVED",
};

// @ts-expect-error a resolved decision cannot be render-pending.
const impossibleReadyPending: CanonicalThumbnailDecision = {
  ...validSample,
  render_status: "PENDING_OUTPUT",
};

void impossibleSamplePackage;
void impossibleSourceMissing;
void incompleteFallback;
void impossibleHumanWithoutApprover;
void impossibleGoldSceneCrop;
void impossibleModeApprovedSceneCrop;
void impossibleReadyPending;
