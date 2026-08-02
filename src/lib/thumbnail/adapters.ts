import { canonicalizeProductCodeValue } from "../fanza/normalize.ts";
import {
  assertCanonicalThumbnailDecision,
  modeContract,
  ThumbnailDecisionContractError,
} from "./contract.ts";
import {
  THUMBNAIL_MODES,
  type CanonicalThumbnailDecision,
  type ThumbnailCropSpec,
  type ThumbnailMode,
} from "./types.ts";

export type CanonicalDecisionRecord = {
  code: unknown;
  mode: unknown;
  state: "RESOLVED" | "PENDING_SOURCE" | "PENDING_OUTPUT" | "NEEDS_USER_REVIEW";
  source_id?: unknown;
  source_path_or_url?: unknown;
  source_hash?: unknown;
  output_path_or_url?: unknown;
  output_hash?: unknown;
  crop_spec?: ThumbnailCropSpec | null;
  approved_by?: unknown;
  approved_at?: unknown;
  approval_batch?: unknown;
  reason: unknown;
};

const MODE_ALIASES: Readonly<Record<string, ThumbnailMode>> = {
  full: "PACKAGE_FULL",
  package_full: "PACKAGE_FULL",
  right: "PACKAGE_RIGHT",
  package_right: "PACKAGE_RIGHT",
  center: "PACKAGE_CENTER",
  package_center: "PACKAGE_CENTER",
  sample: "SAMPLE",
  scene_full: "SCENE_FULL",
  scene_crop: "SCENE_CROP",
};

const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const requiredText = (value: unknown, field: string) => {
  const normalized = text(value);
  if (!normalized) {
    throw new ThumbnailDecisionContractError(`${field} is required`);
  }
  return normalized;
};

const optionalText = (value: unknown) => text(value);

function canonicalCode(value: unknown) {
  const result = canonicalizeProductCodeValue(value);
  if (!result.canonical || result.rejected) {
    throw new ThumbnailDecisionContractError(
      result.rejectionReason ?? "a canonical product code is required",
    );
  }
  return result.canonical;
}

function canonicalMode(value: unknown): ThumbnailMode {
  const normalized = requiredText(value, "mode");
  const direct = normalized.toUpperCase() as ThumbnailMode;
  if (THUMBNAIL_MODES.includes(direct)) return direct;
  const alias = MODE_ALIASES[normalized.toLowerCase()];
  if (!alias) {
    throw new ThumbnailDecisionContractError(`unsupported thumbnail mode: ${normalized}`);
  }
  return alias;
}

function assertAbsent(record: CanonicalDecisionRecord, fields: Array<keyof CanonicalDecisionRecord>) {
  for (const field of fields) {
    if (record[field] !== null && record[field] !== undefined && record[field] !== "") {
      throw new ThumbnailDecisionContractError(
        `${record.state} cannot provide ${String(field)}`,
      );
    }
  }
}

function adaptRecord(
  record: CanonicalDecisionRecord,
  sourceApproval:
    | "HUMAN_APPROVED"
    | "MODE_APPROVED"
    | "GOLD_APPROVED"
    | "LOCAL_APPROVED",
): CanonicalThumbnailDecision {
  if (sourceApproval === "MODE_APPROVED" && record.state !== "RESOLVED") {
    throw new ThumbnailDecisionContractError(
      "MODE_APPROVED source provenance requires a RESOLVED decision",
    );
  }
  const code = canonicalCode(record.code);
  const mode = canonicalMode(record.mode);
  const contract = modeContract(mode);
  const reason = requiredText(record.reason, "reason");
  const cropSpec = record.crop_spec ?? null;
  const approvedBy = optionalText(record.approved_by);
  const approvedAt = optionalText(record.approved_at);
  const approvalBatch = optionalText(record.approval_batch);
  const base = {
    code,
    mode,
    source_kind: contract.source_kind,
    object_fit: contract.object_fit,
    crop_spec: cropSpec,
    approved_by: approvedBy,
    approved_at: approvedAt,
    ...(approvalBatch ? { approval_batch: approvalBatch } : {}),
    reason,
  } as const;

  let decision: Record<string, unknown>;
  if (record.state === "RESOLVED") {
    decision = {
      ...base,
      kind: "RESOLVED",
      source_id: requiredText(record.source_id, "source_id"),
      source_path_or_url: requiredText(record.source_path_or_url, "source_path_or_url"),
      source_hash: requiredText(record.source_hash, "source_hash"),
      output_path_or_url: requiredText(record.output_path_or_url, "output_path_or_url"),
      output_hash: requiredText(record.output_hash, "output_hash"),
      approval_status: sourceApproval,
      render_status: "READY",
    };
  } else if (record.state === "PENDING_SOURCE") {
    if (sourceApproval !== "HUMAN_APPROVED") {
      throw new ThumbnailDecisionContractError(
        "PENDING_SOURCE mode approval must come from a human decision",
      );
    }
    assertAbsent(record, [
      "source_id",
      "source_path_or_url",
      "source_hash",
      "output_path_or_url",
      "output_hash",
    ]);
    decision = {
      ...base,
      kind: "PENDING_SOURCE",
      source_id: null,
      source_path_or_url: null,
      source_hash: null,
      output_path_or_url: null,
      output_hash: null,
      approval_status: "MODE_APPROVED",
      render_status: "PENDING_SOURCE",
    };
  } else if (record.state === "PENDING_OUTPUT") {
    assertAbsent(record, ["output_path_or_url", "output_hash"]);
    decision = {
      ...base,
      kind: "PENDING_OUTPUT",
      source_id: requiredText(record.source_id, "source_id"),
      source_path_or_url: requiredText(record.source_path_or_url, "source_path_or_url"),
      source_hash: requiredText(record.source_hash, "source_hash"),
      output_path_or_url: null,
      output_hash: null,
      approval_status: sourceApproval,
      render_status: "PENDING_OUTPUT",
    };
  } else {
    assertAbsent(record, [
      "source_id",
      "source_path_or_url",
      "source_hash",
      "output_path_or_url",
      "output_hash",
    ]);
    decision = {
      ...base,
      kind: "NEEDS_USER_REVIEW",
      source_id: null,
      source_path_or_url: null,
      source_hash: null,
      output_path_or_url: null,
      output_hash: null,
      approval_status: "NEEDS_USER_REVIEW",
      render_status: "PENDING_SOURCE",
    };
  }

  return assertCanonicalThumbnailDecision(decision);
}

export const adaptGoldLabelRecord = (record: CanonicalDecisionRecord) =>
  adaptRecord(record, "GOLD_APPROVED");

export const adaptHumanApprovalRecord = (record: CanonicalDecisionRecord) =>
  adaptRecord(record, "HUMAN_APPROVED");

export const adaptModeApprovalRecord = (record: CanonicalDecisionRecord) =>
  adaptRecord(record, "MODE_APPROVED");

export const adaptLocalAssetRecord = (record: CanonicalDecisionRecord) =>
  adaptRecord(record, "LOCAL_APPROVED");
