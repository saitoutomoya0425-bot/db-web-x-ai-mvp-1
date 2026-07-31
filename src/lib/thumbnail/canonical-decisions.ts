import { canonicalizeProductCodeValue } from "../fanza/normalize.ts";
import {
  adaptGoldLabelRecord,
  adaptHumanApprovalRecord,
  adaptModeApprovalRecord,
} from "./adapters.ts";
import type { CanonicalThumbnailDecision } from "./types.ts";

const USER_HANDOFF = "USER_HANDOFF";
const HANDOFF_DATE = "2026-07-29";
const HANDOFF_REASON = "2026-07-29 handoff confirmed regression case";
const PHASE_3A_FTO_APPROVAL_DATE = "2026-07-31";

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
    state: "RESOLVED",
    source_id: "sample:12",
    source_path_or_url:
      "https://pics.dmm.co.jp/digital/video/aqugl00004/aqugl00004jp-12.jpg",
    source_hash: "fdb6ab1bdbfb7005b46a626ca06e3a7af31452096b16b270d3b238e91bc68ca3",
    output_path_or_url: "/card-thumbnails/AQUGL00004-gold-sample-12.jpg",
    output_hash: "fdb6ab1bdbfb7005b46a626ca06e3a7af31452096b16b270d3b238e91bc68ca3",
    approved_by: USER_HANDOFF,
    approved_at: HANDOFF_DATE,
    reason: `${HANDOFF_REASON}; sample:12 source and byte-identical output are approved`,
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
  adaptModeApprovalRecord({
    code: "1SBP00423",
    mode: "scene_full",
    state: "RESOLVED",
    source_id: "scene:pl",
    source_path_or_url:
      "https://pics.dmm.co.jp/digital/video/1sbp00423/1sbp00423pl.jpg",
    source_hash: "5467e64d88abe1a9abe13c22c85b53e0871891d89034e77f19abf5ba0080d4ba",
    output_path_or_url:
      "https://pics.dmm.co.jp/digital/video/1sbp00423/1sbp00423pl.jpg",
    output_hash: "5467e64d88abe1a9abe13c22c85b53e0871891d89034e77f19abf5ba0080d4ba",
    approved_by: USER_HANDOFF,
    approved_at: HANDOFF_DATE,
    reason: `${HANDOFF_REASON}; scene:pl is approved as the uncropped SCENE_FULL source`,
  }),
  adaptModeApprovalRecord({
    code: "H_1784FTO00062",
    mode: "full",
    state: "RESOLVED",
    source_id: "dvd:full",
    source_path_or_url:
      "https://pics.dmm.co.jp/digital/video/h_1784fto00062/h_1784fto00062pl.jpg",
    source_hash: "e5cf3c1f156f512a2b13d00c0c517c02214338aa143cda9a18aa75319995a8e3",
    output_path_or_url:
      "https://pics.dmm.co.jp/digital/video/h_1784fto00062/h_1784fto00062pl.jpg",
    output_hash: "e5cf3c1f156f512a2b13d00c0c517c02214338aa143cda9a18aa75319995a8e3",
    approved_by: USER_HANDOFF,
    approved_at: PHASE_3A_FTO_APPROVAL_DATE,
    reason:
      "2026-07-31 user approval supersedes the 2026-07-29 PACKAGE_RIGHT approval: PACKAGE_FULL is required because RIGHT omits the title, multi-person composition, and left-side work information",
  }),
  adaptModeApprovalRecord({
    code: "H_1784FTO00064",
    mode: "full",
    state: "RESOLVED",
    source_id: "dvd:full",
    source_path_or_url:
      "https://pics.dmm.co.jp/digital/video/h_1784fto00064/h_1784fto00064pl.jpg",
    source_hash: "44972d0cad9c01823d9a0a66c470782c9b5185bda449228013e87ca2a63ed59b",
    output_path_or_url:
      "https://pics.dmm.co.jp/digital/video/h_1784fto00064/h_1784fto00064pl.jpg",
    output_hash: "44972d0cad9c01823d9a0a66c470782c9b5185bda449228013e87ca2a63ed59b",
    approved_by: USER_HANDOFF,
    approved_at: PHASE_3A_FTO_APPROVAL_DATE,
    reason:
      "2026-07-31 user approval supersedes the 2026-07-29 PACKAGE_RIGHT approval: PACKAGE_FULL is required because RIGHT omits the left-side description and cast composition",
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
