import { canonicalizeProductCodeValue } from "../fanza/normalize.ts";
import {
  adaptGoldLabelRecord,
  adaptHumanApprovalRecord,
} from "./adapters.ts";
import type { CanonicalThumbnailDecision } from "./types.ts";

const USER_HANDOFF = "USER_HANDOFF";
const HANDOFF_DATE = "2026-07-29";
const HANDOFF_REASON = "2026-07-29 handoff confirmed regression case";

const decisions: CanonicalThumbnailDecision[] = [
  adaptHumanApprovalRecord({
    code: "1START00590",
    mode: "sample",
    state: "RESOLVED",
    source_id: "sample:1",
    source_path_or_url:
      "https://pics.dmm.co.jp/digital/video/1start00590/1start00590jp-1.jpg",
    source_hash: "7ec664dab27c44522ad798ab7d623638d722df88d988b85c96c5411a1fa0db4a",
    output_path_or_url: "/card-thumbnails/1START00590-gold-sample-1.jpg",
    output_hash: "7ec664dab27c44522ad798ab7d623638d722df88d988b85c96c5411a1fa0db4a",
    approved_by: USER_HANDOFF,
    approved_at: HANDOFF_DATE,
    reason: `${HANDOFF_REASON}; sample:1 source and output are approved`,
  }),
  adaptGoldLabelRecord({
    code: "5561SGKT00002",
    mode: "right",
    state: "RESOLVED",
    source_id: "dvd:right",
    source_path_or_url: "public/card-thumbnails/5561SGKT00002-auto-right.jpg",
    source_hash: "8d1675c417f601ad5b5a9ee8d0cbb6a089558e6cd5830e427d4113cc68fdace5",
    output_path_or_url: "/card-thumbnails/5561SGKT00002-auto-right.jpg",
    output_hash: "8d1675c417f601ad5b5a9ee8d0cbb6a089558e6cd5830e427d4113cc68fdace5",
    reason: "Gold label confirms the existing right package output",
  }),
  adaptHumanApprovalRecord({
    code: "AQUGL00004",
    mode: "sample",
    state: "PENDING_OUTPUT",
    source_id: "sample:12",
    source_path_or_url:
      "tmp/card-thumbnail-v3-dry-run/cache/b7f305ea21fb715f2b98b124b42340d6f4413675.jpg",
    source_hash: "85b6fe7a484af6e4176982e7751dadece1c6eda5e19be4bb246fe0e3c36ae275",
    approved_by: USER_HANDOFF,
    approved_at: HANDOFF_DATE,
    reason: `${HANDOFF_REASON}; approved sample:12 has no verified output`,
  }),
  adaptHumanApprovalRecord({
    code: "1NAMHS00006",
    mode: "right",
    state: "RESOLVED",
    source_id: "dvd:right",
    source_path_or_url: "public/card-thumbnails/1NAMHS00006-auto-right.jpg",
    source_hash: "0a4e63642ec70b09ca3da56d9d5ca2f145a014352e87b4336d2f38f39e3a40cb",
    output_path_or_url: "/card-thumbnails/1NAMHS00006-auto-right.jpg",
    output_hash: "0a4e63642ec70b09ca3da56d9d5ca2f145a014352e87b4336d2f38f39e3a40cb",
    approved_by: USER_HANDOFF,
    approved_at: HANDOFF_DATE,
    reason: `${HANDOFF_REASON}; right package face is final`,
  }),
  adaptHumanApprovalRecord({
    code: "H_068MXDLP00335",
    mode: "full",
    state: "RESOLVED",
    source_id: "dvd:full",
    source_path_or_url:
      "https://pics.dmm.co.jp/digital/video/h_068mxdlp00335/h_068mxdlp00335pl.jpg",
    source_hash: "6e8b133a5cf522a3baa10d875e9f9b714c872c477a6b65bc3be75fd59219a7ec",
    output_path_or_url: "/card-thumbnails/H_068MXDLP00335-gold-full.jpg",
    output_hash: "6e8b133a5cf522a3baa10d875e9f9b714c872c477a6b65bc3be75fd59219a7ec",
    approved_by: USER_HANDOFF,
    approved_at: HANDOFF_DATE,
    reason: `${HANDOFF_REASON}; complete package source and output are approved`,
  }),
  adaptHumanApprovalRecord({
    code: "1SBP00423",
    mode: "scene_full",
    state: "PENDING_SOURCE",
    approved_by: USER_HANDOFF,
    approved_at: HANDOFF_DATE,
    reason: `${HANDOFF_REASON}; SCENE_FULL is fixed but source ID is unknown`,
  }),
  adaptHumanApprovalRecord({
    code: "H_1784FTO00062",
    mode: "full",
    state: "NEEDS_USER_REVIEW",
    reason: "PACKAGE_FULL is a candidate; its source ID is not confirmed",
  }),
  adaptHumanApprovalRecord({
    code: "H_1784FTO00064",
    mode: "full",
    state: "NEEDS_USER_REVIEW",
    reason: "PACKAGE_FULL is a candidate; its source ID is not confirmed",
  }),
];

export const PRODUCTION_CANONICAL_THUMBNAIL_DECISIONS: ReadonlyMap<
  string,
  CanonicalThumbnailDecision
> = new Map(decisions.map((decision) => [decision.code, Object.freeze(decision)]));

export function getProductionCanonicalThumbnailDecision(
  code: unknown,
): CanonicalThumbnailDecision | null {
  const canonical = canonicalizeProductCodeValue(code);
  if (!canonical.canonical || canonical.rejected) return null;
  return PRODUCTION_CANONICAL_THUMBNAIL_DECISIONS.get(canonical.canonical) ?? null;
}
