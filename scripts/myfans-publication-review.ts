import postgres from "postgres";
import {
  MYFANS_PUBLICATION_REVIEW_STATE,
  MYFANS_PUBLICATION_VISIBILITY,
  MYFANS_SOURCE_NAME,
  type MyFansAffiliateLinkStatus,
} from "../src/lib/myfans/publication.ts";
import {
  MYFANS_REVIEW_CLASSIFICATION,
  classifyMyFansCreatorForPublication,
  classifyMyFansPostForPublication,
  simulateMyFansAutoApproval,
  type MyFansReviewPermissionContext,
} from "../src/lib/myfans/publication-review.ts";

type SourceRow = {
  id: string;
  name: string;
  source_type: string;
  is_active: boolean;
};

type CreatorRow = {
  id: string;
  data_source_id: string;
  external_creator_id: string;
  profile_slug: string | null;
  display_name: string;
  official_url: string;
  has_profile_image: boolean;
  raw_public_metadata: unknown;
};

type PostRow = {
  id: string;
  data_source_id: string;
  creator_id: string;
  external_post_id: string;
  title: string | null;
  official_url: string;
  media_type: "text" | "image" | "video" | "mixed" | "unknown";
  price: string | number | null;
  currency: string;
  has_thumbnail: boolean;
  raw_public_metadata: unknown;
  affiliate_link_status: MyFansAffiliateLinkStatus;
  affiliate_url: string | null;
};

const databaseUrl = process.env.SUPABASE_DB_URL;
if (!databaseUrl) throw new Error("SUPABASE_DB_URL_REQUIRED");

const permissionContext: MyFansReviewPermissionContext = {
  registeredMediaApproved: true,
  textOnlyPublication: "allowed",
  approvedOnlyPublication: "allowed",
  imageMode: "local_neutral_only",
};

function valuesWithDuplicates(values: readonly (string | null)[]) {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value === null) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([value]) => value));
}

function metadataKeys(value: unknown, keys = new Set<string>()) {
  if (!value || typeof value !== "object") return keys;
  if (Array.isArray(value)) {
    for (const item of value) metadataKeys(item, keys);
    return keys;
  }
  for (const [key, child] of Object.entries(value)) {
    keys.add(key);
    metadataKeys(child, keys);
  }
  return keys;
}

const PRIVATE_KEY = /(account|address|bank|cookie|credential|email|password|phone|session|sms|token|user_id|affiliate_id)/i;
function metadataReview(value: unknown) {
  const keys = [...metadataKeys(value)];
  return {
    prohibited: keys.filter((key) => PRIVATE_KEY.test(key)),
    unexpected: keys.filter((key) => !PRIVATE_KEY.test(key)),
  };
}

function countsByClassification(results: readonly { classification: string }[]) {
  return {
    AUTO_APPROVABLE: results.filter((result) => result.classification === MYFANS_REVIEW_CLASSIFICATION.AUTO_APPROVABLE).length,
    NEEDS_HUMAN_REVIEW: results.filter((result) => result.classification === MYFANS_REVIEW_CLASSIFICATION.NEEDS_HUMAN_REVIEW).length,
    REJECT: results.filter((result) => result.classification === MYFANS_REVIEW_CLASSIFICATION.REJECT).length,
  };
}

function reasonCounts(results: readonly { reasonCodes: readonly string[] }[]) {
  const counts = new Map<string, number>();
  for (const result of results) {
    for (const reason of result.reasonCodes) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

const sql = postgres(databaseUrl, {
  ssl: "require",
  max: 1,
  prepare: false,
  idle_timeout: 20,
  connect_timeout: 20,
});

try {
  const snapshot = await sql.begin(async (tx) => {
    await tx`set transaction read only`;
    const sources = await tx<SourceRow[]>`
      select id, name, source_type, is_active
      from public.data_sources
      where name = ${MYFANS_SOURCE_NAME}
    `;
    if (sources.length !== 1) throw new Error("MYFANS_SOURCE_NOT_EXACT");
    const creators = await tx<CreatorRow[]>`
      select id, data_source_id, external_creator_id, profile_slug, display_name, official_url,
        profile_image_url is not null as has_profile_image,
        raw_public_metadata
      from public.myfans_creators
      where data_source_id = ${sources[0].id}
      order by id
    `;
    const posts = await tx<PostRow[]>`
      select id, data_source_id, creator_id, external_post_id, title, official_url,
        coalesce(media_indicator, content_type, 'unknown') as media_type,
        price, currency, thumbnail_url is not null as has_thumbnail,
        raw_public_metadata, affiliate_link_status, affiliate_url
      from public.myfans_posts
      where data_source_id = ${sources[0].id}
      order by id
    `;
    return { source: sources[0], creators, posts };
  });

  const duplicateCreatorIds = valuesWithDuplicates(snapshot.creators.map((row) => row.external_creator_id));
  const duplicateCreatorSlugs = valuesWithDuplicates(snapshot.creators.map((row) => row.profile_slug));
  const duplicateCreatorUrls = valuesWithDuplicates(snapshot.creators.map((row) => row.official_url));
  const duplicatePostIds = valuesWithDuplicates(snapshot.posts.map((row) => row.external_post_id));
  const duplicatePostUrls = valuesWithDuplicates(snapshot.posts.map((row) => row.official_url));
  const postsByCreator = new Map<string, PostRow[]>();
  for (const post of snapshot.posts) {
    const current = postsByCreator.get(post.creator_id) ?? [];
    current.push(post);
    postsByCreator.set(post.creator_id, current);
  }

  const creatorResults = new Map(snapshot.creators.map((creator) => {
    const metadata = metadataReview(creator.raw_public_metadata);
    const linkedPosts = postsByCreator.get(creator.id) ?? [];
    const identityConflict = creator.profile_slug === null
      || creator.external_creator_id !== `profile_slug:${creator.profile_slug.toLowerCase()}`;
    const review = classifyMyFansCreatorForPublication({
      sourceName: snapshot.source.name,
      externalCreatorId: creator.external_creator_id,
      profileSlug: creator.profile_slug,
      displayName: creator.display_name,
      canonicalProfileUrl: creator.official_url,
      duplicateIdentity: duplicateCreatorIds.has(creator.external_creator_id)
        || (creator.profile_slug !== null && duplicateCreatorSlugs.has(creator.profile_slug))
        || duplicateCreatorUrls.has(creator.official_url),
      identityConflict,
      prohibitedPrivateFields: metadata.prohibited,
      unexpectedMetadataFields: metadata.unexpected,
      hasRightsDependentMedia: creator.has_profile_image,
      linkedPostCount: linkedPosts.length,
      linkedPostRelationsExact: linkedPosts.every((post) => post.data_source_id === creator.data_source_id),
    }, permissionContext);
    return [creator.id, review] as const;
  }));

  const postResults = snapshot.posts.map((post) => {
    const metadata = metadataReview(post.raw_public_metadata);
    const creatorReview = creatorResults.get(post.creator_id);
    if (!creatorReview) throw new Error("POST_CREATOR_NOT_RESOLVED");
    const creatorRelationExact = snapshot.creators.some((creator) =>
      creator.id === post.creator_id && creator.data_source_id === post.data_source_id);
    const review = classifyMyFansPostForPublication({
      sourceName: snapshot.source.name,
      externalPostId: post.external_post_id,
      title: post.title,
      canonicalUrl: post.official_url,
      creatorRelationExact,
      creatorClassification: creatorReview.classification,
      duplicateIdentity: duplicatePostIds.has(post.external_post_id) || duplicatePostUrls.has(post.official_url),
      identityConflict: false,
      prohibitedPrivateFields: metadata.prohibited,
      unexpectedMetadataFields: metadata.unexpected,
      hasRightsDependentMedia: post.has_thumbnail,
      mediaType: post.media_type,
      priceJpy: post.price === null ? null : Number(post.price),
      currency: post.currency,
      affiliateLinkStatus: post.affiliate_link_status as MyFansAffiliateLinkStatus,
      affiliateUrl: post.affiliate_url,
    }, permissionContext);
    return {
      creatorId: post.creator_id,
      review,
      publicationCandidate: {
        sourceName: snapshot.source.name,
        externalPostId: post.external_post_id,
        title: post.title,
        canonicalUrl: post.official_url,
        creatorRelationValid: creatorRelationExact,
        creatorPublicationVisibility: MYFANS_PUBLICATION_VISIBILITY.UNKNOWN,
        creatorPublicationReviewState: MYFANS_PUBLICATION_REVIEW_STATE.NEEDS_REVIEW,
        postPublicationVisibility: MYFANS_PUBLICATION_VISIBILITY.UNKNOWN,
        postPublicationReviewState: MYFANS_PUBLICATION_REVIEW_STATE.NEEDS_REVIEW,
        affiliateLinkStatus: post.affiliate_link_status as MyFansAffiliateLinkStatus,
        affiliateUrl: post.affiliate_url,
        prohibitedPrivateFields: metadata.prohibited,
      },
    };
  });

  const creatorReviewValues = [...creatorResults.values()];
  const autoPosts = postResults.filter(({ review }) => review.classification === MYFANS_REVIEW_CLASSIFICATION.AUTO_APPROVABLE);
  const autoPostsWithAutoCreator = autoPosts.filter(({ creatorId }) =>
    creatorResults.get(creatorId)?.classification === MYFANS_REVIEW_CLASSIFICATION.AUTO_APPROVABLE);
  const simulation = simulateMyFansAutoApproval(postResults.map(({ review, publicationCandidate }) => ({
    review,
    publicationCandidate,
  })));
  const report = {
    mode: "READ_ONLY_CLASSIFICATION",
    db: { selectStatements: 3, writes: 0 },
    source: {
      exact: snapshot.source.name === MYFANS_SOURCE_NAME,
      type: snapshot.source.source_type,
      active: snapshot.source.is_active,
    },
    creators: {
      input: snapshot.creators.length,
      classifications: countsByClassification(creatorReviewValues),
      reasonCodes: reasonCounts(creatorReviewValues),
    },
    posts: {
      input: snapshot.posts.length,
      classifications: countsByClassification(postResults.map(({ review }) => review)),
      reasonCodes: reasonCounts(postResults.map(({ review }) => review)),
    },
    dependencies: {
      autoApprovablePosts: autoPosts.length,
      autoApprovablePostsWithAutoApprovableCreator: autoPostsWithAutoCreator.length,
      creatorReviewDependencyBlocked: postResults.filter(({ review }) => review.reasonCodes.includes("CREATOR_REVIEW_DEPENDENCY")).length,
      creatorRejectedBlocked: postResults.filter(({ review }) => review.reasonCodes.includes("CREATOR_REJECTED")).length,
      missingAffiliateLinkNonBlocking: postResults.filter(({ review }) => review.reasonCodes.includes("AFFILIATE_LINK_MISSING_NON_BLOCKING")).length,
    },
    simulation,
    publicExposure: {
      sourceActive: snapshot.source.is_active,
      actualApprovedProjectionRowsExpected: 0,
    },
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  await sql.end();
}
