import { canonicalizeProductCodeValue } from "../fanza/normalize.ts";
import {
  THUMBNAIL_MODE_CONTRACTS,
  THUMBNAIL_MODES,
  type CanonicalThumbnailDecision,
  type RenderableThumbnailResolution,
  type ResolvedThumbnailDecision,
  type ThumbnailApprovalStatus,
  type ThumbnailCropSpec,
  type ThumbnailDecisionSource,
  type ThumbnailMode,
  type ThumbnailRenderStatus,
} from "./types.ts";

export class ThumbnailDecisionContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThumbnailDecisionContractError";
  }
}

const contractError = (message: string): never => {
  throw new ThumbnailDecisionContractError(message);
};

export const hasText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const SHA256 = /^[a-f0-9]{64}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T.*)?$/;
const TRUSTED_EXTERNAL_IMAGE_HOSTS: ReadonlySet<string> = new Set([
  "pics.dmm.co.jp",
]);
const LOCAL_CARD_THUMBNAIL_PREFIX = "/card-thumbnails/";

function isSafeLocalThumbnailPath(candidate: string) {
  if (
    !candidate.startsWith(LOCAL_CARD_THUMBNAIL_PREFIX) ||
    candidate.startsWith("//") ||
    candidate.includes("\\") ||
    candidate.includes("?") ||
    candidate.includes("#")
  ) {
    return false;
  }
  try {
    let decoded = candidate;
    for (let index = 0; index < 8; index += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
    if (
      decoded.includes("%") ||
      decoded.includes("\\") ||
      decoded.includes("?") ||
      decoded.includes("#")
    ) {
      return false;
    }
    const segments = decoded.split("/");
    return (
      decoded.startsWith(LOCAL_CARD_THUMBNAIL_PREFIX) &&
      segments.every((segment, index) =>
        index === 0 || (segment.length > 0 && segment !== "." && segment !== ".."))
    );
  } catch {
    return false;
  }
}

export function isTrustedThumbnailOutput(value: unknown): value is string {
  if (!hasText(value)) return false;
  const candidate = value.trim();
  if (candidate.startsWith("/")) return isSafeLocalThumbnailPath(candidate);
  try {
    const url = new URL(candidate);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      (url.port === "" || url.port === "443") &&
      TRUSTED_EXTERNAL_IMAGE_HOSTS.has(url.hostname.toLowerCase()) &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

export function modeContract(mode: ThumbnailMode) {
  return THUMBNAIL_MODE_CONTRACTS[mode];
}

function assertMode(value: unknown): asserts value is ThumbnailMode {
  if (!THUMBNAIL_MODES.includes(value as ThumbnailMode)) {
    contractError(`unsupported thumbnail mode: ${String(value)}`);
  }
}

function assertHash(value: unknown, field: string): asserts value is string {
  if (!hasText(value) || !SHA256.test(value)) {
    contractError(`${field} must be a SHA-256 hex digest`);
  }
}

function assertApproval(
  approvedBy: unknown,
  approvedAt: unknown,
  context: string,
) {
  if (!hasText(approvedBy)) {
    contractError(`${context} requires approved_by`);
  }
  if (!hasText(approvedAt) || !ISO_DATE.test(approvedAt)) {
    contractError(`${context} requires an ISO approved_at value`);
  }
}

function assertOptionalApproval(approvedBy: unknown, approvedAt: unknown) {
  const noApprover = approvedBy === null || approvedBy === undefined;
  const noDate = approvedAt === null || approvedAt === undefined;
  if (noApprover && noDate) return;
  assertApproval(approvedBy, approvedAt, "approval provenance");
}

function assertCropSpec(crop: ThumbnailCropSpec) {
  if (crop.unit !== "pixel" && crop.unit !== "ratio") {
    contractError("crop_spec.unit must be pixel or ratio");
  }
  const values = [crop.x, crop.y, crop.width, crop.height];
  if (
    !values.every(Number.isFinite) ||
    crop.x < 0 ||
    crop.y < 0 ||
    crop.width <= 0 ||
    crop.height <= 0
  ) {
    contractError("crop_spec must contain non-negative finite coordinates and positive dimensions");
  }
  if (
    crop.unit === "ratio" &&
    (crop.width > 1 ||
      crop.height > 1 ||
      crop.x + crop.width > 1 ||
      crop.y + crop.height > 1)
  ) {
    contractError("ratio crop_spec must remain inside the source image");
  }
}

export function assertModeContract(input: {
  mode: unknown;
  source_kind: unknown;
  source_id: unknown;
  object_fit: unknown;
  crop_spec: unknown;
}) {
  assertMode(input.mode);
  const contract = THUMBNAIL_MODE_CONTRACTS[input.mode];
  if (input.source_kind !== contract.source_kind) {
    contractError(`${input.mode} requires source_kind=${contract.source_kind}`);
  }
  if (input.object_fit !== contract.object_fit) {
    contractError(`${input.mode} requires object_fit=${contract.object_fit}`);
  }
  if (input.source_id !== null) {
    if (
      !hasText(input.source_id) ||
      !new RegExp(contract.source_id_pattern).test(input.source_id)
    ) {
      contractError(`${input.mode} has an invalid source_id`);
    }
  }
  if (contract.crop === "required") {
    if (!input.crop_spec || typeof input.crop_spec !== "object") {
      contractError(`${input.mode} requires crop_spec`);
    }
    assertCropSpec(input.crop_spec as ThumbnailCropSpec);
  } else if (input.crop_spec !== null) {
    contractError(`${input.mode} requires crop_spec=null`);
  }
}

const SOURCE_APPROVALS: ReadonlySet<ThumbnailApprovalStatus> = new Set([
  "HUMAN_APPROVED",
  "GOLD_APPROVED",
  "LOCAL_APPROVED",
]);

function assertSourceApproval(
  candidate: Record<string, unknown>,
  context: string,
  allowModeApproval = false,
) {
  const approvalStatus = candidate.approval_status as ThumbnailApprovalStatus;
  if (
    !SOURCE_APPROVALS.has(approvalStatus) &&
    !(allowModeApproval && approvalStatus === "MODE_APPROVED")
  ) {
    contractError(`${context} requires a confirmed source approval`);
  }
  if (
    approvalStatus === "HUMAN_APPROVED" ||
    approvalStatus === "MODE_APPROVED"
  ) {
    assertApproval(candidate.approved_by, candidate.approved_at, approvalStatus);
  } else {
    assertOptionalApproval(candidate.approved_by, candidate.approved_at);
  }
}

export function assertCanonicalThumbnailDecision(
  decision: unknown,
): CanonicalThumbnailDecision {
  if (!decision || typeof decision !== "object") {
    contractError("canonical decision must be an object");
  }
  const candidate = decision as Record<string, unknown>;
  if ("decision_status" in candidate) {
    contractError("legacy decision_status is not allowed; use approval_status and render_status");
  }
  const canonical = canonicalizeProductCodeValue(candidate.code);
  if (!canonical.canonical || canonical.rejected || canonical.canonical !== candidate.code) {
    contractError(`canonical decision requires a canonical code: ${String(candidate.code)}`);
  }
  if (!hasText(candidate.reason)) {
    contractError("decision reason is required");
  }
  assertModeContract({
    mode: candidate.mode,
    source_kind: candidate.source_kind,
    source_id: candidate.source_id,
    object_fit: candidate.object_fit,
    crop_spec: candidate.crop_spec,
  });

  if (candidate.mode === "SCENE_CROP") {
    if (
      candidate.kind !== "RESOLVED" ||
      candidate.approval_status !== "HUMAN_APPROVED" ||
      candidate.render_status !== "READY"
    ) {
      contractError("SCENE_CROP requires a ready work-level human approval");
    }
  }

  if (candidate.kind === "RESOLVED") {
    if (candidate.render_status !== "READY") {
      contractError("RESOLVED requires render_status=READY");
    }
    if (!hasText(candidate.source_id)) contractError("RESOLVED requires source_id");
    if (!hasText(candidate.source_path_or_url)) {
      contractError("RESOLVED requires source_path_or_url");
    }
    assertHash(candidate.source_hash, "source_hash");
    if (!isTrustedThumbnailOutput(candidate.output_path_or_url)) {
      contractError("RESOLVED requires a trusted output_path_or_url");
    }
    assertHash(candidate.output_hash, "output_hash");
    assertSourceApproval(candidate, "RESOLVED", true);
    return decision as CanonicalThumbnailDecision;
  }

  if (candidate.kind === "PENDING_SOURCE") {
    if (
      candidate.render_status !== "PENDING_SOURCE" ||
      candidate.approval_status !== "MODE_APPROVED" ||
      candidate.source_id !== null ||
      candidate.source_path_or_url !== null ||
      candidate.source_hash !== null ||
      candidate.output_path_or_url !== null ||
      candidate.output_hash !== null
    ) {
      contractError("PENDING_SOURCE requires an approved mode without source or output provenance");
    }
    assertApproval(candidate.approved_by, candidate.approved_at, "MODE_APPROVED");
    return decision as CanonicalThumbnailDecision;
  }

  if (candidate.kind === "PENDING_OUTPUT") {
    if (candidate.render_status !== "PENDING_OUTPUT") {
      contractError("PENDING_OUTPUT requires render_status=PENDING_OUTPUT");
    }
    if (!hasText(candidate.source_id)) contractError("PENDING_OUTPUT requires source_id");
    if (!hasText(candidate.source_path_or_url)) {
      contractError("PENDING_OUTPUT requires source_path_or_url");
    }
    assertHash(candidate.source_hash, "source_hash");
    if (candidate.output_path_or_url !== null || candidate.output_hash !== null) {
      contractError("PENDING_OUTPUT cannot claim output provenance");
    }
    assertSourceApproval(candidate, "PENDING_OUTPUT");
    return decision as CanonicalThumbnailDecision;
  }

  if (
    candidate.kind !== "NEEDS_USER_REVIEW" ||
    candidate.render_status !== "PENDING_SOURCE" ||
    candidate.approval_status !== "NEEDS_USER_REVIEW"
  ) {
    contractError(`unsupported canonical decision kind: ${String(candidate.kind)}`);
  }
  if (
    candidate.source_id !== null ||
    candidate.source_path_or_url !== null ||
    candidate.source_hash !== null ||
    candidate.output_path_or_url !== null ||
    candidate.output_hash !== null
  ) {
    contractError("NEEDS_USER_REVIEW cannot claim confirmed source or output provenance");
  }
  assertOptionalApproval(candidate.approved_by, candidate.approved_at);
  return decision as CanonicalThumbnailDecision;
}

const CANONICAL_SOURCES = new Set([
  "production_canonical",
  "human_decision",
  "gold_label",
  "local_generated_asset",
]);
const FALLBACK_SOURCES = new Set(["database_url", "external_fallback"]);
const SOURCE_APPROVAL_CONTRACT = Object.freeze({
  human_decision: Object.freeze([
    "HUMAN_APPROVED",
    "MODE_APPROVED",
    "NEEDS_USER_REVIEW",
  ] as const),
  gold_label: Object.freeze([
    "GOLD_APPROVED",
    "NEEDS_USER_REVIEW",
  ] as const),
  local_generated_asset: Object.freeze(["LOCAL_APPROVED"] as const),
});

export function assertDecisionSourceApproval(
  source: Exclude<
    ThumbnailDecisionSource,
    "production_canonical" | "database_url" | "external_fallback" | "none"
  >,
  approvalStatus: ThumbnailApprovalStatus,
) {
  if (!(SOURCE_APPROVAL_CONTRACT[source] as readonly ThumbnailApprovalStatus[])
    .includes(approvalStatus)) {
    contractError(`approval status ${approvalStatus} is invalid for ${source}`);
  }
}

function sameValue(left: unknown, right: unknown) {
  if (left === right) return true;
  if (
    left && right &&
    typeof left === "object" &&
    typeof right === "object"
  ) {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return false;
}

function assertCanonicalResolution(candidate: Record<string, unknown>) {
  if (!candidate.canonical_decision || typeof candidate.canonical_decision !== "object") {
    contractError("canonical resolution requires canonical_decision");
  }
  const decision = assertCanonicalThumbnailDecision(candidate.canonical_decision);
  if (
    candidate.decision_source === "human_decision" ||
    candidate.decision_source === "gold_label" ||
    candidate.decision_source === "local_generated_asset"
  ) {
    assertDecisionSourceApproval(
      candidate.decision_source,
      decision.approval_status,
    );
  }
  const comparedFields = [
    "code",
    "kind",
    "mode",
    "source_id",
    "source_kind",
    "source_path_or_url",
    "source_hash",
    "output_path_or_url",
    "output_hash",
    "object_fit",
    "crop_spec",
    "approval_status",
    "render_status",
    "approved_by",
    "approved_at",
    "reason",
  ] as const;
  if (candidate.canonical_code !== decision.code) {
    contractError("canonical resolution code does not match canonical_decision");
  }
  for (const field of comparedFields) {
    if (!sameValue(candidate[field], decision[field])) {
      contractError(`canonical resolution ${field} does not match canonical_decision`);
    }
  }
  if (decision.kind === "RESOLVED") {
    if (
      candidate.resolved_url !== decision.output_path_or_url ||
      !isTrustedThumbnailOutput(candidate.resolved_url)
    ) {
      contractError("ready canonical resolution requires its trusted output URL");
    }
  } else if (candidate.resolved_url !== null) {
    contractError("non-ready canonical resolution requires resolved_url=null");
  }
}

function assertFallbackResolution(candidate: Record<string, unknown>) {
  if (
    candidate.kind !== "RESOLVED" ||
    candidate.render_status !== "READY" ||
    candidate.approval_status !== "UNREVIEWED" ||
    candidate.canonical_decision !== null
  ) {
    contractError("fallback resolution has invalid state");
  }
  const canonical = canonicalizeProductCodeValue(candidate.canonical_code);
  if (
    !canonical.canonical ||
    canonical.rejected ||
    canonical.canonical !== candidate.canonical_code
  ) {
    contractError("fallback resolution requires a canonical code");
  }
  if (!hasText(candidate.source_path_or_url)) {
    contractError("fallback resolution requires source_path_or_url");
  }
  if (!hasText(candidate.reason)) contractError("fallback resolution requires reason");
  if (
    !isTrustedThumbnailOutput(candidate.output_path_or_url) ||
    candidate.resolved_url !== candidate.output_path_or_url
  ) {
    contractError("fallback resolution requires one trusted output URL");
  }
  if (candidate.source_hash !== null || candidate.output_hash !== null) {
    contractError("fallback resolution cannot invent hashes");
  }
  if (
    candidate.decision_source === "external_fallback" &&
    !String(candidate.resolved_url).startsWith("https://")
  ) {
    contractError("external fallback requires HTTPS");
  }
  assertModeContract({
    mode: candidate.mode,
    source_kind: candidate.source_kind,
    source_id: candidate.source_id,
    object_fit: candidate.object_fit,
    crop_spec: candidate.crop_spec,
  });
}

export function validateThumbnailResolution(
  resolution: unknown,
): ResolvedThumbnailDecision {
  if (!resolution || typeof resolution !== "object") {
    contractError("thumbnail resolution must be an object");
  }
  const candidate = resolution as Record<string, unknown>;
  if (!hasText(candidate.reason)) contractError("thumbnail resolution requires reason");

  if (candidate.kind === "SOURCE_MISSING" || candidate.kind === "INVALID_CODE") {
    const nullFields = [
      "mode",
      "source_id",
      "source_kind",
      "source_path_or_url",
      "source_hash",
      "output_path_or_url",
      "output_hash",
      "resolved_url",
      "object_fit",
      "crop_spec",
      "approval_status",
      "render_status",
      "canonical_decision",
    ];
    if (
      candidate.decision_source !== "none" ||
      nullFields.some((field) => candidate[field] !== null)
    ) {
      contractError(`${candidate.kind} has invalid provenance`);
    }
    if (candidate.kind === "INVALID_CODE" && candidate.canonical_code !== null) {
      contractError("INVALID_CODE requires canonical_code=null");
    }
    if (candidate.kind === "SOURCE_MISSING") {
      const canonical = canonicalizeProductCodeValue(candidate.canonical_code);
      if (
        !canonical.canonical ||
        canonical.rejected ||
        canonical.canonical !== candidate.canonical_code
      ) {
        contractError("SOURCE_MISSING requires a canonical code");
      }
    }
    return resolution as ResolvedThumbnailDecision;
  }

  if (CANONICAL_SOURCES.has(String(candidate.decision_source))) {
    assertCanonicalResolution(candidate);
  } else if (FALLBACK_SOURCES.has(String(candidate.decision_source))) {
    assertFallbackResolution(candidate);
  } else {
    contractError(`unsupported decision_source: ${String(candidate.decision_source)}`);
  }
  return resolution as ResolvedThumbnailDecision;
}

export function isRenderableThumbnailResolution(
  resolution: unknown,
): resolution is RenderableThumbnailResolution {
  try {
    const validated = validateThumbnailResolution(resolution);
    return validated.kind === "RESOLVED" && validated.render_status === "READY";
  } catch {
    return false;
  }
}
