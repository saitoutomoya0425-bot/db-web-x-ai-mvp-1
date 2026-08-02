const frozenModeContract = <
  SourceKind extends "PACKAGE" | "SAMPLE" | "SCENE",
  ObjectFit extends "cover" | "contain",
  SourceIdPattern extends string,
  Crop extends "none" | "required",
>(
  source_kind: SourceKind,
  object_fit: ObjectFit,
  source_id_pattern: SourceIdPattern,
  crop: Crop,
) => Object.freeze({ source_kind, object_fit, source_id_pattern, crop });

export const THUMBNAIL_MODE_CONTRACTS = Object.freeze({
  PACKAGE_FULL: frozenModeContract("PACKAGE", "contain", "^dvd:full$", "none"),
  PACKAGE_RIGHT: frozenModeContract("PACKAGE", "cover", "^dvd:right$", "none"),
  PACKAGE_CENTER: frozenModeContract("PACKAGE", "cover", "^dvd:center$", "none"),
  SAMPLE: frozenModeContract("SAMPLE", "cover", "^sample:[1-9]\\d*$", "none"),
  SCENE_FULL: frozenModeContract("SCENE", "contain", "^(?:scene|file):.+$", "none"),
  SCENE_CROP: frozenModeContract("SCENE", "cover", "^(?:scene|file):.+$", "required"),
});

export type ThumbnailMode = keyof typeof THUMBNAIL_MODE_CONTRACTS;
export const THUMBNAIL_MODES = Object.freeze(
  Object.keys(THUMBNAIL_MODE_CONTRACTS) as ThumbnailMode[],
);
export type ThumbnailObjectFit =
  (typeof THUMBNAIL_MODE_CONTRACTS)[ThumbnailMode]["object_fit"];
export type ThumbnailSourceKind =
  (typeof THUMBNAIL_MODE_CONTRACTS)[ThumbnailMode]["source_kind"];

export type ThumbnailApprovalStatus =
  | "HUMAN_APPROVED"
  | "MODE_APPROVED"
  | "GOLD_APPROVED"
  | "LOCAL_APPROVED"
  | "NEEDS_USER_REVIEW"
  | "UNREVIEWED";

export type ThumbnailRenderStatus =
  | "READY"
  | "PENDING_SOURCE"
  | "PENDING_OUTPUT";

export type ThumbnailDecisionSource =
  | "production_canonical"
  | "human_decision"
  | "gold_label"
  | "local_generated_asset"
  | "database_url"
  | "external_fallback"
  | "none";

export type ThumbnailCropSpec = {
  unit: "pixel" | "ratio";
  x: number;
  y: number;
  width: number;
  height: number;
  rotation_degrees?: 0 | 90 | 180 | 270;
};

type ModeContractFor<Mode extends ThumbnailMode> = {
  readonly mode: Mode;
  readonly source_kind: (typeof THUMBNAIL_MODE_CONTRACTS)[Mode]["source_kind"];
  readonly object_fit: (typeof THUMBNAIL_MODE_CONTRACTS)[Mode]["object_fit"];
  readonly crop_spec:
    (typeof THUMBNAIL_MODE_CONTRACTS)[Mode]["crop"] extends "required"
      ? ThumbnailCropSpec
      : null;
};

type PendingMode = Exclude<ThumbnailMode, "SCENE_CROP">;

export type PendingThumbnailModeContract = {
  [Mode in PendingMode]: ModeContractFor<Mode>;
}[PendingMode];

export type ResolvedThumbnailModeContract = {
  [Mode in ThumbnailMode]: ModeContractFor<Mode> & {
    readonly source_id: string;
  };
}[ThumbnailMode];

type CanonicalDecisionIdentity = {
  readonly code: string;
  readonly reason: string;
};

type ApprovalBatchMetadata = {
  readonly approval_batch?: string | null;
};

type OptionalApprovalMetadata = ApprovalBatchMetadata & {
  readonly approved_by: string | null;
  readonly approved_at: string | null;
};

type RequiredApprovalMetadata = ApprovalBatchMetadata & {
  readonly approved_by: string;
  readonly approved_at: string;
};

type HumanSourceApproval = RequiredApprovalMetadata & {
  readonly approval_status: "HUMAN_APPROVED";
};

type GoldSourceApproval = OptionalApprovalMetadata & {
  readonly approval_status: "GOLD_APPROVED";
};

type LocalSourceApproval = OptionalApprovalMetadata & {
  readonly approval_status: "LOCAL_APPROVED";
};

type ModeSourceApproval = RequiredApprovalMetadata & {
  readonly approval_status: "MODE_APPROVED";
};

type ConfirmedSourceApproval =
  | HumanSourceApproval
  | GoldSourceApproval
  | LocalSourceApproval;

type ResolvedSourceApproval =
  | ConfirmedSourceApproval
  | ModeSourceApproval;

type ResolvedCanonicalProvenance = {
  readonly kind: "RESOLVED";
  readonly render_status: "READY";
  readonly source_path_or_url: string;
  readonly source_hash: string;
  readonly output_path_or_url: string;
  readonly output_hash: string;
};

export type ResolvedCanonicalThumbnailDecision =
  | (CanonicalDecisionIdentity &
      Exclude<ResolvedThumbnailModeContract, { mode: "SCENE_CROP" }> &
      ResolvedCanonicalProvenance &
      ResolvedSourceApproval)
  | (CanonicalDecisionIdentity &
      Extract<ResolvedThumbnailModeContract, { mode: "SCENE_CROP" }> &
      ResolvedCanonicalProvenance &
      HumanSourceApproval);

export type PendingSourceCanonicalThumbnailDecision =
  CanonicalDecisionIdentity &
  RequiredApprovalMetadata &
  PendingThumbnailModeContract & {
    readonly kind: "PENDING_SOURCE";
    readonly render_status: "PENDING_SOURCE";
    readonly approval_status: "MODE_APPROVED";
    readonly source_id: null;
    readonly source_path_or_url: null;
    readonly source_hash: null;
    readonly output_path_or_url: null;
    readonly output_hash: null;
  };

export type PendingOutputCanonicalThumbnailDecision =
  CanonicalDecisionIdentity &
  ConfirmedSourceApproval &
  Exclude<ResolvedThumbnailModeContract, { mode: "SCENE_CROP" }> & {
    readonly kind: "PENDING_OUTPUT";
    readonly render_status: "PENDING_OUTPUT";
    readonly source_path_or_url: string;
    readonly source_hash: string;
    readonly output_path_or_url: null;
    readonly output_hash: null;
  };

export type NeedsUserReviewCanonicalThumbnailDecision =
  CanonicalDecisionIdentity &
  OptionalApprovalMetadata &
  PendingThumbnailModeContract & {
    readonly kind: "NEEDS_USER_REVIEW";
    readonly render_status: "PENDING_SOURCE";
    readonly approval_status: "NEEDS_USER_REVIEW";
    readonly source_id: null;
    readonly source_path_or_url: null;
    readonly source_hash: null;
    readonly output_path_or_url: null;
    readonly output_hash: null;
  };

export type CanonicalThumbnailDecision =
  | ResolvedCanonicalThumbnailDecision
  | PendingSourceCanonicalThumbnailDecision
  | PendingOutputCanonicalThumbnailDecision
  | NeedsUserReviewCanonicalThumbnailDecision;

export type ThumbnailFallbackCandidate =
  Exclude<ResolvedThumbnailModeContract, { mode: "SCENE_CROP" }> & {
    source_path_or_url: string;
    url: string | null;
    reason: string;
  };

export type ThumbnailResolutionInput = {
  code: unknown;
  human_decision?: CanonicalThumbnailDecision | null;
  gold_label?: CanonicalThumbnailDecision | null;
  local_generated_asset?: CanonicalThumbnailDecision | null;
  database_url?: ThumbnailFallbackCandidate | null;
  external_fallback?: ThumbnailFallbackCandidate | null;
};

type CanonicalDecisionSource =
  | "production_canonical"
  | "human_decision"
  | "gold_label"
  | "local_generated_asset";

export type CanonicalRenderableThumbnailResolution =
  ResolvedCanonicalThumbnailDecision & {
    readonly canonical_code: string;
    readonly resolved_url: string;
    readonly decision_source: CanonicalDecisionSource;
    readonly canonical_decision: ResolvedCanonicalThumbnailDecision;
  };

export type FallbackRenderableThumbnailResolution =
  Exclude<ResolvedThumbnailModeContract, { mode: "SCENE_CROP" }> & {
    readonly kind: "RESOLVED";
    readonly canonical_code: string;
    readonly source_path_or_url: string;
    readonly source_hash: null;
    readonly output_path_or_url: string;
    readonly output_hash: null;
    readonly resolved_url: string;
    readonly approval_status: "UNREVIEWED";
    readonly render_status: "READY";
    readonly decision_source: "database_url" | "external_fallback";
    readonly reason: string;
    readonly canonical_decision: null;
  };

export type RenderableThumbnailResolution =
  | CanonicalRenderableThumbnailResolution
  | FallbackRenderableThumbnailResolution;

export type PendingSourceThumbnailResolution =
  PendingSourceCanonicalThumbnailDecision & {
    readonly canonical_code: string;
    readonly resolved_url: null;
    readonly decision_source: CanonicalDecisionSource;
    readonly canonical_decision: PendingSourceCanonicalThumbnailDecision;
  };

export type PendingOutputThumbnailResolution =
  PendingOutputCanonicalThumbnailDecision & {
    readonly canonical_code: string;
    readonly resolved_url: null;
    readonly decision_source: CanonicalDecisionSource;
    readonly canonical_decision: PendingOutputCanonicalThumbnailDecision;
  };

export type NeedsUserReviewThumbnailResolution =
  NeedsUserReviewCanonicalThumbnailDecision & {
    readonly canonical_code: string;
    readonly resolved_url: null;
    readonly decision_source: CanonicalDecisionSource;
    readonly canonical_decision: NeedsUserReviewCanonicalThumbnailDecision;
  };

export type NonRenderableDecisionResolution =
  | PendingSourceThumbnailResolution
  | PendingOutputThumbnailResolution
  | NeedsUserReviewThumbnailResolution;

export type SourceMissingThumbnailResolution = {
  readonly kind: "SOURCE_MISSING";
  readonly canonical_code: string;
  readonly mode: null;
  readonly source_id: null;
  readonly source_kind: null;
  readonly source_path_or_url: null;
  readonly source_hash: null;
  readonly output_path_or_url: null;
  readonly output_hash: null;
  readonly resolved_url: null;
  readonly object_fit: null;
  readonly crop_spec: null;
  readonly approval_status: null;
  readonly render_status: null;
  readonly decision_source: "none";
  readonly reason: string;
  readonly canonical_decision: null;
};

export type InvalidCodeThumbnailResolution = {
  readonly kind: "INVALID_CODE";
  readonly canonical_code: null;
  readonly mode: null;
  readonly source_id: null;
  readonly source_kind: null;
  readonly source_path_or_url: null;
  readonly source_hash: null;
  readonly output_path_or_url: null;
  readonly output_hash: null;
  readonly resolved_url: null;
  readonly object_fit: null;
  readonly crop_spec: null;
  readonly approval_status: null;
  readonly render_status: null;
  readonly decision_source: "none";
  readonly reason: string;
  readonly canonical_decision: null;
};

export type ResolvedThumbnailDecision =
  | RenderableThumbnailResolution
  | NonRenderableDecisionResolution
  | SourceMissingThumbnailResolution
  | InvalidCodeThumbnailResolution;

export type LegacyThumbnailSourceKind =
  | "PHASE4B_EXPLICIT_LEGACY"
  | "LEGACY_RUNTIME_OVERRIDE"
  | "LEGACY_DB_URL";

export type Phase4BLegacyThumbnailRecord = {
  readonly code: string;
  readonly mode:
    | "SAMPLE"
    | "PACKAGE_RIGHT"
    | "PACKAGE_CENTER"
    | "PACKAGE_FULL";
  readonly source_id: string;
  readonly resolved_url: string;
  readonly render_strategy: "AUDIT_OUTPUT" | "CSS_PACKAGE_POSITION";
  readonly object_fit: ThumbnailObjectFit;
  readonly object_position: "center" | "right";
};

export type LegacyRuntimeThumbnailOverride = {
  readonly path: string;
  readonly mode: string;
  readonly source_id: string;
  readonly output_hash: string | null;
};

type LegacyCompatibilityThumbnailBase = {
  readonly kind: "RESOLVED";
  readonly resolution_kind: "LEGACY_COMPAT";
  readonly canonical_code: string;
  readonly source_path_or_url: string;
  readonly source_hash: null;
  readonly output_path_or_url: string;
  readonly resolved_url: string;
  readonly object_fit: ThumbnailObjectFit;
  readonly crop_spec: null;
  readonly approval_status: "UNREVIEWED";
  readonly render_status: "READY";
  readonly decision_source: "legacy_compatibility";
  readonly reason: string;
  readonly canonical_decision: null;
};

export type LegacyCompatibilityThumbnailResolution =
  | (LegacyCompatibilityThumbnailBase & {
      readonly mode: Phase4BLegacyThumbnailRecord["mode"];
      readonly source_id: string;
      readonly source_kind: "PHASE4B_EXPLICIT_LEGACY";
      readonly output_hash: null;
      readonly object_position: "center" | "right";
    })
  | (LegacyCompatibilityThumbnailBase & {
      readonly mode: ThumbnailMode | null;
      readonly source_id: string;
      readonly source_kind: "LEGACY_RUNTIME_OVERRIDE";
      readonly output_hash: string | null;
    })
  | (LegacyCompatibilityThumbnailBase & {
      readonly mode: null;
      readonly source_id:
        | "videos.card_thumbnail_url"
        | "videos.thumbnail_url";
      readonly source_kind: "LEGACY_DB_URL";
      readonly output_hash: null;
    });

export type CanonicalThumbnailPresentationResolution =
  | (RenderableThumbnailResolution & {
      readonly resolution_kind: "CANONICAL";
    })
  | (NonRenderableDecisionResolution & {
      readonly resolution_kind: "CANONICAL";
    });

export type NonRenderableThumbnailPresentationResolution =
  | (SourceMissingThumbnailResolution & {
      readonly resolution_kind: "NON_RENDERABLE";
    })
  | (InvalidCodeThumbnailResolution & {
      readonly resolution_kind: "NON_RENDERABLE";
    });

export type ThumbnailPresentationResolution =
  | CanonicalThumbnailPresentationResolution
  | LegacyCompatibilityThumbnailResolution
  | NonRenderableThumbnailPresentationResolution;

export type ThumbnailPresentationInput = {
  readonly code: unknown;
  readonly human_decision?: CanonicalThumbnailDecision | null;
  readonly gold_label?: CanonicalThumbnailDecision | null;
  readonly local_generated_asset?: CanonicalThumbnailDecision | null;
  readonly canonical_lookup_outcome?: {
    readonly kind: "SOURCE_MISSING";
    readonly reason: string;
  } | null;
  readonly legacy_runtime_override: LegacyRuntimeThumbnailOverride | null;
  readonly legacy_card_url?: unknown;
  readonly legacy_thumbnail_url?: unknown;
};

export type ThumbnailRenderAuditAttributes = {
  readonly code: string | null;
  readonly resolution_kind:
    | "CANONICAL"
    | "LEGACY_COMPAT"
    | "NON_RENDERABLE";
  readonly mode: ThumbnailMode | "LEGACY_UNCLASSIFIED" | null;
  readonly source_id: string | null;
  readonly approval_status: ThumbnailApprovalStatus | null;
  readonly render_status: ThumbnailRenderStatus | null;
};

export type ThumbnailRenderContract = {
  readonly src: string | null;
  readonly object_fit: ThumbnailObjectFit | null;
  readonly object_position: "center" | "right" | null;
  readonly crop_spec: ThumbnailCropSpec | null;
  readonly attributes: ThumbnailRenderAuditAttributes;
  readonly reason: string;
};
