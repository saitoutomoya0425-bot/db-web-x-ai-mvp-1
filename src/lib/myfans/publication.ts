export const MYFANS_SOURCE_NAME = "MyFans Affiliate Center" as const;

export const MYFANS_PUBLICATION_VISIBILITY = {
  UNKNOWN: "unknown",
  PUBLIC_GENERAL: "public_general",
  AFFILIATE_VISIBLE: "affiliate_visible",
  APPROVED_AFFILIATE_ONLY: "approved_affiliate_only",
  NOT_PUBLIC: "not_public",
} as const;

export const MYFANS_PUBLICATION_REVIEW_STATE = {
  NEEDS_REVIEW: "needs_review",
  APPROVED: "approved",
  REJECTED: "rejected",
  BLOCKED: "blocked",
} as const;

export const MYFANS_AFFILIATE_LINK_STATUS = {
  MISSING: "missing",
  ACTIVE: "active",
  INELIGIBLE: "ineligible",
  REVOKED: "revoked",
} as const;

export type MyFansPublicationVisibility =
  (typeof MYFANS_PUBLICATION_VISIBILITY)[keyof typeof MYFANS_PUBLICATION_VISIBILITY];
export type MyFansPublicationReviewState =
  (typeof MYFANS_PUBLICATION_REVIEW_STATE)[keyof typeof MYFANS_PUBLICATION_REVIEW_STATE];
export type MyFansAffiliateLinkStatus =
  (typeof MYFANS_AFFILIATE_LINK_STATUS)[keyof typeof MYFANS_AFFILIATE_LINK_STATUS];

export type MyFansPublicationBlockReason =
  | "source_not_myfans"
  | "creator_visibility_not_approved"
  | "creator_review_not_approved"
  | "post_visibility_not_approved"
  | "post_review_not_approved"
  | "title_missing"
  | "external_post_id_invalid"
  | "canonical_url_invalid"
  | "canonical_url_identity_mismatch"
  | "creator_relation_invalid"
  | "prohibited_private_fields_present";

export type MyFansPublicationCandidate = {
  sourceName: string;
  externalPostId: string;
  title: string | null;
  canonicalUrl: string | null;
  creatorRelationValid: boolean;
  creatorPublicationVisibility: MyFansPublicationVisibility;
  creatorPublicationReviewState: MyFansPublicationReviewState;
  postPublicationVisibility: MyFansPublicationVisibility;
  postPublicationReviewState: MyFansPublicationReviewState;
  affiliateLinkStatus: MyFansAffiliateLinkStatus;
  affiliateUrl: string | null;
  prohibitedPrivateFields?: readonly string[];
};

export type MyFansAffiliateCtaDecision = {
  show: boolean;
  url: string | null;
  reason: "active_valid" | "status_not_active" | "active_url_invalid";
};

export type MyFansPublicationDecision = {
  eligible: boolean;
  blockReasons: MyFansPublicationBlockReason[];
  canonicalOutboundUrl: string | null;
  affiliateCta: MyFansAffiliateCtaDecision;
  imageRequired: false;
  placeholder: "local_neutral";
};

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APPROVED_VISIBILITIES = new Set<MyFansPublicationVisibility>([
  MYFANS_PUBLICATION_VISIBILITY.PUBLIC_GENERAL,
  MYFANS_PUBLICATION_VISIBILITY.AFFILIATE_VISIBLE,
  MYFANS_PUBLICATION_VISIBILITY.APPROVED_AFFILIATE_ONLY,
]);

function normalizedHttpsUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      (url.port !== "" && url.port !== "443")
    ) return null;
    return url;
  } catch {
    return null;
  }
}

export function isCanonicalMyFansPostUrl(value: string | null, externalPostId: string) {
  if (!UUID_LIKE.test(externalPostId)) return false;
  const url = normalizedHttpsUrl(value);
  return Boolean(
    url &&
    url.hostname.toLowerCase() === "myfans.jp" &&
    url.pathname.toLowerCase() === `/posts/${externalPostId.toLowerCase()}` &&
    url.search === "" &&
    url.hash === "",
  );
}

export function isValidMyFansAffiliateUrl(value: string | null) {
  const url = normalizedHttpsUrl(value);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  return host === "myfans.jp" || host.endsWith(".myfans.jp");
}

export function decideMyFansAffiliateCta(
  status: MyFansAffiliateLinkStatus,
  affiliateUrl: string | null,
): MyFansAffiliateCtaDecision {
  if (status !== MYFANS_AFFILIATE_LINK_STATUS.ACTIVE) {
    return { show: false, url: null, reason: "status_not_active" };
  }
  if (!isValidMyFansAffiliateUrl(affiliateUrl)) {
    return { show: false, url: null, reason: "active_url_invalid" };
  }
  return { show: true, url: affiliateUrl, reason: "active_valid" };
}

export function decideMyFansPublication(
  candidate: MyFansPublicationCandidate,
): MyFansPublicationDecision {
  const blockReasons: MyFansPublicationBlockReason[] = [];
  const externalPostIdValid = UUID_LIKE.test(candidate.externalPostId);
  const canonicalUrl = normalizedHttpsUrl(candidate.canonicalUrl);

  if (candidate.sourceName !== MYFANS_SOURCE_NAME) blockReasons.push("source_not_myfans");
  if (!APPROVED_VISIBILITIES.has(candidate.creatorPublicationVisibility)) {
    blockReasons.push("creator_visibility_not_approved");
  }
  if (candidate.creatorPublicationReviewState !== MYFANS_PUBLICATION_REVIEW_STATE.APPROVED) {
    blockReasons.push("creator_review_not_approved");
  }
  if (!APPROVED_VISIBILITIES.has(candidate.postPublicationVisibility)) {
    blockReasons.push("post_visibility_not_approved");
  }
  if (candidate.postPublicationReviewState !== MYFANS_PUBLICATION_REVIEW_STATE.APPROVED) {
    blockReasons.push("post_review_not_approved");
  }
  if (!candidate.title?.trim()) blockReasons.push("title_missing");
  if (!externalPostIdValid) blockReasons.push("external_post_id_invalid");
  if (!canonicalUrl || canonicalUrl.hostname.toLowerCase() !== "myfans.jp") {
    blockReasons.push("canonical_url_invalid");
  } else if (!isCanonicalMyFansPostUrl(candidate.canonicalUrl, candidate.externalPostId)) {
    blockReasons.push("canonical_url_identity_mismatch");
  }
  if (!candidate.creatorRelationValid) blockReasons.push("creator_relation_invalid");
  if (candidate.prohibitedPrivateFields?.length) {
    blockReasons.push("prohibited_private_fields_present");
  }

  return {
    eligible: blockReasons.length === 0,
    blockReasons,
    canonicalOutboundUrl: isCanonicalMyFansPostUrl(candidate.canonicalUrl, candidate.externalPostId)
      ? candidate.canonicalUrl
      : null,
    affiliateCta: decideMyFansAffiliateCta(candidate.affiliateLinkStatus, candidate.affiliateUrl),
    imageRequired: false,
    placeholder: "local_neutral",
  };
}

export function approvedMyFansPublicationProjection<T extends MyFansPublicationCandidate>(
  candidates: readonly T[],
) {
  return candidates.filter((candidate) => decideMyFansPublication(candidate).eligible);
}
