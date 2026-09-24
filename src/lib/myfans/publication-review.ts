import {
  MYFANS_AFFILIATE_LINK_STATUS,
  MYFANS_PUBLICATION_REVIEW_STATE,
  MYFANS_PUBLICATION_VISIBILITY,
  MYFANS_SOURCE_NAME,
  decideMyFansPublication,
  isCanonicalMyFansPostUrl,
  type MyFansAffiliateLinkStatus,
  type MyFansPublicationCandidate,
} from "./publication.ts";

export const MYFANS_REVIEW_CLASSIFICATION = {
  AUTO_APPROVABLE: "AUTO_APPROVABLE",
  NEEDS_HUMAN_REVIEW: "NEEDS_HUMAN_REVIEW",
  REJECT: "REJECT",
} as const;

export type MyFansReviewClassification =
  (typeof MYFANS_REVIEW_CLASSIFICATION)[keyof typeof MYFANS_REVIEW_CLASSIFICATION];

export type MyFansReviewPermissionContext = {
  registeredMediaApproved: boolean;
  textOnlyPublication: "allowed" | "unknown" | "denied";
  approvedOnlyPublication: "allowed" | "unknown" | "denied";
  imageMode: "local_neutral_only";
};

export type MyFansCreatorReviewInput = {
  sourceName: string;
  externalCreatorId: string;
  profileSlug: string | null;
  displayName: string;
  canonicalProfileUrl: string;
  duplicateIdentity: boolean;
  identityConflict: boolean;
  prohibitedPrivateFields: readonly string[];
  unexpectedMetadataFields: readonly string[];
  hasRightsDependentMedia: boolean;
  linkedPostCount: number;
  linkedPostRelationsExact: boolean;
};

export type MyFansPostReviewInput = {
  sourceName: string;
  externalPostId: string;
  title: string | null;
  canonicalUrl: string;
  creatorRelationExact: boolean;
  creatorClassification: MyFansReviewClassification;
  duplicateIdentity: boolean;
  identityConflict: boolean;
  prohibitedPrivateFields: readonly string[];
  unexpectedMetadataFields: readonly string[];
  hasRightsDependentMedia: boolean;
  mediaType: "text" | "image" | "video" | "mixed" | "unknown";
  priceJpy: number | null;
  currency: string;
  affiliateLinkStatus: MyFansAffiliateLinkStatus;
  affiliateUrl: string | null;
};

export type MyFansReviewResult = {
  classification: MyFansReviewClassification;
  reasonCodes: string[];
  recommendedPublicationVisibility: "affiliate_visible" | null;
  recommendedPublicationReviewState: "approved" | null;
};

export type MyFansSimulatedPostReview = {
  review: MyFansReviewResult;
  publicationCandidate: MyFansPublicationCandidate;
};

const CREATOR_SLUG = /^[A-Za-z0-9_.-]{1,64}$/;
const MEDIA_TYPES = new Set(["text", "image", "video", "mixed", "unknown"]);

function permissionReasons(context: MyFansReviewPermissionContext) {
  const reject: string[] = [];
  const review: string[] = [];
  if (!context.registeredMediaApproved) review.push("REGISTERED_MEDIA_APPROVAL_UNCONFIRMED");
  if (context.textOnlyPublication === "denied") reject.push("TEXT_ONLY_PUBLICATION_DENIED");
  else if (context.textOnlyPublication === "unknown") review.push("TEXT_ONLY_PUBLICATION_PERMISSION_UNKNOWN");
  if (context.approvedOnlyPublication === "denied") reject.push("APPROVED_ONLY_PUBLICATION_DENIED");
  else if (context.approvedOnlyPublication === "unknown") review.push("APPROVED_ONLY_PUBLICATION_PERMISSION_UNKNOWN");
  return { reject, review };
}

function canonicalCreatorProfileMatches(urlValue: string, profileSlug: string | null) {
  if (!profileSlug || !CREATOR_SLUG.test(profileSlug)) return false;
  try {
    const url = new URL(urlValue);
    const segments = url.pathname.split("/").filter(Boolean);
    return url.protocol === "https:"
      && url.hostname.toLowerCase() === "myfans.jp"
      && url.username === ""
      && url.password === ""
      && (url.port === "" || url.port === "443")
      && url.search === ""
      && url.hash === ""
      && segments.length === 1
      && decodeURIComponent(segments[0]).toLowerCase() === profileSlug.toLowerCase();
  } catch {
    return false;
  }
}

function result(
  rejectReasons: string[],
  reviewReasons: string[],
  evidenceReasons: string[],
): MyFansReviewResult {
  if (rejectReasons.length) {
    return {
      classification: MYFANS_REVIEW_CLASSIFICATION.REJECT,
      reasonCodes: [...new Set([...rejectReasons, ...reviewReasons, ...evidenceReasons])],
      recommendedPublicationVisibility: null,
      recommendedPublicationReviewState: null,
    };
  }
  if (reviewReasons.length) {
    return {
      classification: MYFANS_REVIEW_CLASSIFICATION.NEEDS_HUMAN_REVIEW,
      reasonCodes: [...new Set([...reviewReasons, ...evidenceReasons])],
      recommendedPublicationVisibility: null,
      recommendedPublicationReviewState: null,
    };
  }
  return {
    classification: MYFANS_REVIEW_CLASSIFICATION.AUTO_APPROVABLE,
    reasonCodes: [...new Set(evidenceReasons)],
    recommendedPublicationVisibility: MYFANS_PUBLICATION_VISIBILITY.AFFILIATE_VISIBLE,
    recommendedPublicationReviewState: MYFANS_PUBLICATION_REVIEW_STATE.APPROVED,
  };
}

export function classifyMyFansCreatorForPublication(
  creator: MyFansCreatorReviewInput,
  context: MyFansReviewPermissionContext,
): MyFansReviewResult {
  const permission = permissionReasons(context);
  const rejectReasons = [...permission.reject];
  const reviewReasons = [...permission.review];
  const evidenceReasons: string[] = [];
  const slugValid = Boolean(creator.profileSlug && CREATOR_SLUG.test(creator.profileSlug));
  const externalIdentityValid = Boolean(
    slugValid
    && creator.externalCreatorId === `profile_slug:${creator.profileSlug!.toLowerCase()}`,
  );

  if (creator.sourceName !== MYFANS_SOURCE_NAME) rejectReasons.push("SOURCE_NOT_MYFANS");
  if (creator.duplicateIdentity) rejectReasons.push("DUPLICATE_CREATOR_IDENTITY");
  if (creator.identityConflict) rejectReasons.push("CREATOR_IDENTITY_CONFLICT");
  if (!externalIdentityValid) rejectReasons.push("CREATOR_STABLE_IDENTITY_INVALID");
  if (!creator.displayName.trim()) rejectReasons.push("CREATOR_NAME_MISSING");
  if (!canonicalCreatorProfileMatches(creator.canonicalProfileUrl, creator.profileSlug)) {
    rejectReasons.push("CREATOR_CANONICAL_PROFILE_MISMATCH");
  }
  if (creator.prohibitedPrivateFields.length) rejectReasons.push("PROHIBITED_PRIVATE_DATA_PRESENT");
  if (creator.unexpectedMetadataFields.length) reviewReasons.push("UNEXPECTED_METADATA_REQUIRES_REVIEW");
  if (creator.hasRightsDependentMedia) reviewReasons.push("RIGHTS_DEPENDENT_MEDIA_PRESENT");
  if (creator.linkedPostCount < 1) reviewReasons.push("CREATOR_HAS_NO_LINKED_POSTS");
  if (!creator.linkedPostRelationsExact) rejectReasons.push("CREATOR_POST_RELATION_CONFLICT");

  if (!rejectReasons.length && !reviewReasons.length) {
    evidenceReasons.push("TEXT_ONLY_CREATOR_CONTRACT_SATISFIED");
  }
  return result(rejectReasons, reviewReasons, evidenceReasons);
}

export function classifyMyFansPostForPublication(
  post: MyFansPostReviewInput,
  context: MyFansReviewPermissionContext,
): MyFansReviewResult {
  const permission = permissionReasons(context);
  const rejectReasons = [...permission.reject];
  const reviewReasons = [...permission.review];
  const evidenceReasons: string[] = [];

  if (post.sourceName !== MYFANS_SOURCE_NAME) rejectReasons.push("SOURCE_NOT_MYFANS");
  if (post.duplicateIdentity) rejectReasons.push("DUPLICATE_POST_IDENTITY");
  if (post.identityConflict) rejectReasons.push("POST_IDENTITY_CONFLICT");
  if (!isCanonicalMyFansPostUrl(post.canonicalUrl, post.externalPostId)) {
    rejectReasons.push("POST_CANONICAL_IDENTITY_INVALID");
  }
  if (!post.title?.trim()) rejectReasons.push("POST_TITLE_MISSING");
  if (!post.creatorRelationExact) rejectReasons.push("POST_CREATOR_RELATION_CONFLICT");
  if (post.creatorClassification === MYFANS_REVIEW_CLASSIFICATION.REJECT) {
    rejectReasons.push("CREATOR_REJECTED");
  } else if (post.creatorClassification !== MYFANS_REVIEW_CLASSIFICATION.AUTO_APPROVABLE) {
    reviewReasons.push("CREATOR_REVIEW_DEPENDENCY");
  }
  if (post.prohibitedPrivateFields.length) rejectReasons.push("PROHIBITED_PRIVATE_DATA_PRESENT");
  if (post.unexpectedMetadataFields.length) reviewReasons.push("UNEXPECTED_METADATA_REQUIRES_REVIEW");
  if (post.hasRightsDependentMedia) reviewReasons.push("RIGHTS_DEPENDENT_MEDIA_PRESENT");
  if (!MEDIA_TYPES.has(post.mediaType)) rejectReasons.push("POST_MEDIA_TYPE_INVALID");
  if (post.priceJpy !== null && (!Number.isSafeInteger(post.priceJpy) || post.priceJpy < 0)) {
    rejectReasons.push("POST_PRICE_INVALID");
  }
  if (post.currency !== "JPY") rejectReasons.push("POST_CURRENCY_INVALID");

  if (post.priceJpy === null) evidenceReasons.push("OPTIONAL_PRICE_MISSING");
  if (post.mediaType === "unknown") evidenceReasons.push("OPTIONAL_MEDIA_TYPE_UNKNOWN");
  if (post.affiliateLinkStatus === MYFANS_AFFILIATE_LINK_STATUS.MISSING && post.affiliateUrl === null) {
    evidenceReasons.push("AFFILIATE_LINK_MISSING_NON_BLOCKING");
  }
  if (!rejectReasons.length && !reviewReasons.length) {
    evidenceReasons.unshift("TEXT_ONLY_POST_CONTRACT_SATISFIED");
  }
  return result(rejectReasons, reviewReasons, evidenceReasons);
}

export function simulateMyFansAutoApproval(posts: readonly MyFansSimulatedPostReview[]) {
  const decisions = posts.map(({ review, publicationCandidate }) => {
    if (review.classification !== MYFANS_REVIEW_CLASSIFICATION.AUTO_APPROVABLE) return null;
    return decideMyFansPublication({
      ...publicationCandidate,
      creatorPublicationVisibility: MYFANS_PUBLICATION_VISIBILITY.AFFILIATE_VISIBLE,
      creatorPublicationReviewState: MYFANS_PUBLICATION_REVIEW_STATE.APPROVED,
      postPublicationVisibility: MYFANS_PUBLICATION_VISIBILITY.AFFILIATE_VISIBLE,
      postPublicationReviewState: MYFANS_PUBLICATION_REVIEW_STATE.APPROVED,
    });
  });
  return {
    eligiblePosts: decisions.filter((decision) => decision?.eligible).length,
    blockedPosts: posts.length - decisions.filter((decision) => decision?.eligible).length,
    affiliateCtaCount: decisions.filter((decision) => decision?.affiliateCta.show).length,
    placeholderCount: decisions.filter((decision) => decision?.placeholder === "local_neutral").length,
    projectionCandidateCount: decisions.filter((decision) => decision?.eligible).length,
  };
}
