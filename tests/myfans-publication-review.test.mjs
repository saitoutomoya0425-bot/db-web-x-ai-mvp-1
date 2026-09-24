import assert from "node:assert/strict";
import test from "node:test";
import {
  MYFANS_AFFILIATE_LINK_STATUS,
  MYFANS_PUBLICATION_REVIEW_STATE,
  MYFANS_PUBLICATION_VISIBILITY,
  MYFANS_SOURCE_NAME,
} from "../src/lib/myfans/publication.ts";
import {
  MYFANS_REVIEW_CLASSIFICATION,
  classifyMyFansCreatorForPublication,
  classifyMyFansPostForPublication,
  simulateMyFansAutoApproval,
} from "../src/lib/myfans/publication-review.ts";

const context = {
  registeredMediaApproved: true,
  textOnlyPublication: "allowed",
  approvedOnlyPublication: "allowed",
  imageMode: "local_neutral_only",
};

const creator = {
  sourceName: MYFANS_SOURCE_NAME,
  externalCreatorId: "profile_slug:_synthetic.creator",
  profileSlug: "_synthetic.creator",
  displayName: "Synthetic Creator",
  canonicalProfileUrl: "https://myfans.jp/_synthetic.creator",
  duplicateIdentity: false,
  identityConflict: false,
  prohibitedPrivateFields: [],
  unexpectedMetadataFields: [],
  hasRightsDependentMedia: false,
  linkedPostCount: 2,
  linkedPostRelationsExact: true,
};

const postId = "123e4567-e89b-12d3-a456-426614174000";
const post = {
  sourceName: MYFANS_SOURCE_NAME,
  externalPostId: postId,
  title: "Synthetic title",
  canonicalUrl: `https://myfans.jp/posts/${postId}`,
  creatorRelationExact: true,
  creatorClassification: MYFANS_REVIEW_CLASSIFICATION.AUTO_APPROVABLE,
  duplicateIdentity: false,
  identityConflict: false,
  prohibitedPrivateFields: [],
  unexpectedMetadataFields: [],
  hasRightsDependentMedia: false,
  mediaType: "video",
  priceJpy: 1980,
  currency: "JPY",
  affiliateLinkStatus: MYFANS_AFFILIATE_LINK_STATUS.MISSING,
  affiliateUrl: null,
};

test("complete text-only creator is auto approvable without inferring real-world identity", () => {
  const result = classifyMyFansCreatorForPublication(creator, context);
  assert.equal(result.classification, MYFANS_REVIEW_CLASSIFICATION.AUTO_APPROVABLE);
  assert.equal(result.recommendedPublicationVisibility, MYFANS_PUBLICATION_VISIBILITY.AFFILIATE_VISIBLE);
  assert.deepEqual(result.reasonCodes, ["TEXT_ONLY_CREATOR_CONTRACT_SATISFIED"]);
});

test("creator identity conflict or private data is rejected", () => {
  const result = classifyMyFansCreatorForPublication({
    ...creator,
    identityConflict: true,
    prohibitedPrivateFields: ["account_id"],
  }, context);
  assert.equal(result.classification, MYFANS_REVIEW_CLASSIFICATION.REJECT);
  assert.ok(result.reasonCodes.includes("CREATOR_IDENTITY_CONFLICT"));
  assert.ok(result.reasonCodes.includes("PROHIBITED_PRIVATE_DATA_PRESENT"));
});

test("unknown permission or rights-dependent media requires human review", () => {
  const result = classifyMyFansCreatorForPublication({
    ...creator,
    hasRightsDependentMedia: true,
  }, { ...context, approvedOnlyPublication: "unknown" });
  assert.equal(result.classification, MYFANS_REVIEW_CLASSIFICATION.NEEDS_HUMAN_REVIEW);
  assert.ok(result.reasonCodes.includes("APPROVED_ONLY_PUBLICATION_PERMISSION_UNKNOWN"));
  assert.ok(result.reasonCodes.includes("RIGHTS_DEPENDENT_MEDIA_PRESENT"));
});

test("complete text-only post is auto approvable and missing affiliate link is non-blocking", () => {
  const result = classifyMyFansPostForPublication(post, context);
  assert.equal(result.classification, MYFANS_REVIEW_CLASSIFICATION.AUTO_APPROVABLE);
  assert.ok(result.reasonCodes.includes("TEXT_ONLY_POST_CONTRACT_SATISFIED"));
  assert.ok(result.reasonCodes.includes("AFFILIATE_LINK_MISSING_NON_BLOCKING"));
});

test("optional missing price and unknown media remain auto approvable", () => {
  const result = classifyMyFansPostForPublication({
    ...post,
    priceJpy: null,
    mediaType: "unknown",
  }, context);
  assert.equal(result.classification, MYFANS_REVIEW_CLASSIFICATION.AUTO_APPROVABLE);
  assert.ok(result.reasonCodes.includes("OPTIONAL_PRICE_MISSING"));
  assert.ok(result.reasonCodes.includes("OPTIONAL_MEDIA_TYPE_UNKNOWN"));
});

test("invalid UUID URL, title, price, and creator relation reject a post", () => {
  const result = classifyMyFansPostForPublication({
    ...post,
    externalPostId: "invalid",
    canonicalUrl: "https://example.test/post",
    title: "",
    creatorRelationExact: false,
    priceJpy: -1,
  }, context);
  assert.equal(result.classification, MYFANS_REVIEW_CLASSIFICATION.REJECT);
  assert.ok(result.reasonCodes.includes("POST_CANONICAL_IDENTITY_INVALID"));
  assert.ok(result.reasonCodes.includes("POST_TITLE_MISSING"));
  assert.ok(result.reasonCodes.includes("POST_CREATOR_RELATION_CONFLICT"));
  assert.ok(result.reasonCodes.includes("POST_PRICE_INVALID"));
});

test("post inherits a creator review dependency", () => {
  const result = classifyMyFansPostForPublication({
    ...post,
    creatorClassification: MYFANS_REVIEW_CLASSIFICATION.NEEDS_HUMAN_REVIEW,
  }, context);
  assert.equal(result.classification, MYFANS_REVIEW_CLASSIFICATION.NEEDS_HUMAN_REVIEW);
  assert.ok(result.reasonCodes.includes("CREATOR_REVIEW_DEPENDENCY"));
});

test("simulated approval yields eligible text-only posts with no affiliate CTA", () => {
  const review = classifyMyFansPostForPublication(post, context);
  const simulation = simulateMyFansAutoApproval([{
    review,
    publicationCandidate: {
      sourceName: MYFANS_SOURCE_NAME,
      externalPostId: post.externalPostId,
      title: post.title,
      canonicalUrl: post.canonicalUrl,
      creatorRelationValid: true,
      creatorPublicationVisibility: MYFANS_PUBLICATION_VISIBILITY.UNKNOWN,
      creatorPublicationReviewState: MYFANS_PUBLICATION_REVIEW_STATE.NEEDS_REVIEW,
      postPublicationVisibility: MYFANS_PUBLICATION_VISIBILITY.UNKNOWN,
      postPublicationReviewState: MYFANS_PUBLICATION_REVIEW_STATE.NEEDS_REVIEW,
      affiliateLinkStatus: MYFANS_AFFILIATE_LINK_STATUS.MISSING,
      affiliateUrl: null,
      prohibitedPrivateFields: [],
    },
  }]);
  assert.deepEqual(simulation, {
    eligiblePosts: 1,
    blockedPosts: 0,
    affiliateCtaCount: 0,
    placeholderCount: 1,
    projectionCandidateCount: 1,
  });
});
