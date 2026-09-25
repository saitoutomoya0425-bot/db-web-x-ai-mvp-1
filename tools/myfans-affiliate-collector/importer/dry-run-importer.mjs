import { createHash } from "node:crypto";

export const IMPORTER_VERSION = "myfans-catalog-dry-run-v1";
export const EXPECTED_SCHEMA_VERSION = "myfans-affiliate-catalog-local-v1";
export const SUPPORTED_COLLECTOR_VERSIONS = Object.freeze(["0.1.8", "0.2.0", "0.2.1"]);

const SOURCE_NAME = "MYFANS_AFFILIATE_CENTER";
const SOURCE_TYPE = "OFFICIAL_AUTH_UI";
const AFFILIATE_HOST = "www.affiliate.myfans.jp";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USERNAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MEDIA_TYPES = new Set(["text", "image", "video", "mixed", "unknown"]);
const PARSER_CONFIDENCE = new Set(["HIGH", "MEDIUM", "LOW"]);
const SENSITIVE_QUERY_KEY_RE = /^(?:access_token|account|affiliate_id|auth|authorization|cookie|email|password|session|token)$/i;

const TOP_LEVEL_FIELDS = new Set([
  "schema_version",
  "cumulative_schema_version",
  "collector_version",
  "export_kind",
  "source",
  "collection_scope",
  "collection_run",
  "collected_at",
  "first_collected_at",
  "last_collected_at",
  "stop_reason",
  "checkpoint_summary",
  "run_count",
  "runs",
  "pages",
  "creators",
  "posts",
  "post_observations",
  "creator_observations",
  "merge_summary",
  "counts",
  "warnings"
]);

const POST_FIELDS = new Set([
  "post_uuid",
  "post_public_url",
  "title",
  "creator_name",
  "creator_username",
  "creator_profile_url",
  "price_jpy",
  "affiliate_reward_rate",
  "estimated_reward_jpy",
  "media_type",
  "video_duration",
  "video_duration_seconds",
  "likes",
  "relative_published_text",
  "affiliate_eligible",
  "displayed_affiliate_url",
  "source_surface",
  "source_page_url",
  "collected_at",
  "parser_confidence",
  "title_diagnostic"
]);

const CREATOR_FIELDS = new Set([
  "creator_name",
  "username",
  "profile_url",
  "likes",
  "followers",
  "following",
  "post_count",
  "affiliate_enabled_post_count",
  "single_reward_rate",
  "plan_initial_reward_rate",
  "plan_continuation_reward_rate",
  "plans",
  "social_profile_urls",
  "source_surface",
  "source_page_url",
  "collected_at",
  "parser_confidence"
]);

const PROHIBITED_KEY_RE = /^(?:account_id|account_name|affiliate_id|avatar(?:_url)?|bank(?:_information)?|cookie|dom_html|email|har|headers|html|identity_document|image(?:_src|_url)?|img|local_storage|media_blob|ogp(?:_url)?|password|poster(?:_url)?|raw_dom|raw_html|revenue|session|session_storage|src|thumbnail(?:_url)?|token|video_url)$/i;

export const FIELD_MAPPING = Object.freeze([
  { source: "post_uuid", target: "myfans_posts.external_post_id", classification: "A", rule: "lowercase validated UUID" },
  { source: "post_public_url", target: "myfans_posts.official_url", classification: "A", rule: "exact UUID/URL cross-check" },
  { source: "title", target: "myfans_posts.title", classification: "A", rule: "trim only; no inferred completion" },
  { source: "media_type", target: "myfans_posts.content_type,media_indicator", classification: "A", rule: "existing enum allowlist" },
  { source: "price_jpy", target: "myfans_posts.price,currency", classification: "A", rule: "non-negative integer + JPY" },
  { source: "collected_at", target: "myfans_posts.fetched_at", classification: "B", rule: "validated ISO timestamp" },
  { source: "creator_username", target: "myfans_creators.external_creator_id,profile_slug", classification: "B", rule: "profile_slug:<lowercase slug>; never merge by name" },
  { source: "creator_name", target: "myfans_creators.display_name", classification: "A", rule: "non-empty trim" },
  { source: "creator_username/profile_url", target: "myfans_creators.official_url", classification: "B", rule: "canonical https://myfans.jp/<slug>" },
  { source: "collected_at", target: "myfans_creators.fetched_at", classification: "B", rule: "latest exact observation per creator" },
  { source: "affiliate_reward_rate", target: null, classification: "C", rule: "affiliate-state schema missing" },
  { source: "estimated_reward_jpy", target: null, classification: "C", rule: "affiliate-state schema missing" },
  { source: "affiliate_eligible", target: null, classification: "C", rule: "affiliate-state schema missing" },
  { source: "video_duration,video_duration_seconds", target: null, classification: "C", rule: "migration 029 has no duration column" },
  { source: "likes", target: null, classification: "C", rule: "metric snapshot schema missing" },
  { source: "collector_version,source_page_url,source_surface,parser_confidence", target: null, classification: "C", rule: "observation/provenance schema missing; retained in dry-run sidecar" },
  { source: "relative_published_text", target: null, classification: "D", rule: "relative time is never converted to published_at" },
  { source: "title_diagnostic", target: null, classification: "D", rule: "diagnostic data is not staged" },
  { source: "displayed_affiliate_url", target: null, classification: "D", rule: "affiliate link lifecycle is outside Phase 6K.1" },
  { source: "image/avatar/thumbnail/OGP/video URL", target: null, classification: "D", rule: "prohibited by text-only permission boundary" },
  { source: "plan display data", target: "myfans_plans", classification: "E", rule: "hold until a stable plan ID exists" },
  { source: "visibility/approval scope", target: null, classification: "E", rule: "do not overload content visibility; affiliate-state schema required" }
]);

export const SCHEMA_GAPS = Object.freeze([
  "DATA_SOURCE_ID_REQUIRES_READ_ONLY_DB_RESOLUTION",
  "CREATOR_ID_REQUIRES_READ_ONLY_DB_RESOLUTION",
  "AUTH_UI_PROVENANCE_STORAGE_MISSING",
  "POST_AFFILIATE_STATE_STORAGE_MISSING",
  "CREATOR_AFFILIATE_STATE_STORAGE_MISSING",
  "METRIC_SNAPSHOT_STORAGE_MISSING",
  "VIDEO_DURATION_STORAGE_MISSING",
  "PLAN_STABLE_ID_REQUIRED"
]);

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])])
  );
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
}

function exactObjectFields(value, allowedFields, scope) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [`${scope}_NOT_OBJECT`];
  return Object.keys(value)
    .filter((key) => !allowedFields.has(key))
    .sort()
    .map((key) => `UNEXPECTED_${scope}_FIELD:${key}`);
}

function prohibitedFieldPaths(value, currentPath = "$") {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => prohibitedFieldPaths(item, `${currentPath}[${index}]`));
  }
  if (!value || typeof value !== "object") return [];
  const paths = [];
  for (const [key, child] of Object.entries(value)) {
    if (PROHIBITED_KEY_RE.test(key)) paths.push(`${currentPath}.${key}`);
    paths.push(...prohibitedFieldPaths(child, `${currentPath}.${key}`));
  }
  return paths;
}

function isoTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function parsePostIdentity(postUuid, postUrl) {
  const uuid = normalizeText(postUuid).toLowerCase();
  if (!UUID_RE.test(uuid)) return { error: "INVALID_OR_MISSING_POST_UUID" };
  let url;
  try {
    url = new URL(postUrl);
  } catch {
    return { error: "MALFORMED_POST_PUBLIC_URL" };
  }
  if (
    url.protocol !== "https:" ||
    !["myfans.jp", "www.myfans.jp"].includes(url.hostname) ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    url.search ||
    url.hash ||
    url.pathname.toLowerCase() !== `/posts/${uuid}`
  ) {
    return { error: "MALFORMED_OR_MISMATCHED_POST_PUBLIC_URL" };
  }
  return { uuid, officialUrl: `https://myfans.jp/posts/${uuid}` };
}

function parseCreatorProfileUrl(value) {
  if (value == null) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return { error: "MALFORMED_CREATOR_PROFILE_URL" };
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (
    url.protocol !== "https:" ||
    !["myfans.jp", "www.myfans.jp"].includes(url.hostname) ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    url.search ||
    url.hash ||
    segments.length !== 1
  ) {
    return { error: "MALFORMED_CREATOR_PROFILE_URL" };
  }
  let username;
  try {
    username = decodeURIComponent(segments[0]);
  } catch {
    return { error: "MALFORMED_CREATOR_PROFILE_URL" };
  }
  if (!USERNAME_RE.test(username)) return { error: "MALFORMED_CREATOR_IDENTITY" };
  return { username, officialUrl: `https://myfans.jp/${encodeURIComponent(username)}` };
}

function normalizeCreatorIdentity(post) {
  const suppliedUsername = normalizeText(post.creator_username);
  const profile = parseCreatorProfileUrl(post.creator_profile_url);
  if (profile?.error) return { error: profile.error };
  if (!suppliedUsername && !profile) return { error: "MISSING_CREATOR_IDENTITY" };
  const username = suppliedUsername || profile.username;
  if (!USERNAME_RE.test(username)) return { error: "MALFORMED_CREATOR_IDENTITY" };
  if (profile && profile.username.toLowerCase() !== username.toLowerCase()) {
    return { error: "CONFLICTING_CREATOR_IDENTITY" };
  }
  const displayName = normalizeText(post.creator_name);
  if (!displayName) return { error: "MISSING_CREATOR_DISPLAY_NAME" };
  return {
    username,
    normalizedSlug: username.toLowerCase(),
    displayName,
    externalCreatorId: `profile_slug:${username.toLowerCase()}`,
    officialUrl: profile?.officialUrl || `https://myfans.jp/${encodeURIComponent(username)}`
  };
}

function nullableNonNegativeInteger(value, field, reasons) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    reasons.push(`INVALID_${field.toUpperCase()}`);
    return null;
  }
  return value;
}

function nullableRate(value, reasons) {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    reasons.push("INVALID_AFFILIATE_REWARD_RATE");
    return null;
  }
  return value;
}

function sourceSurfaceFromUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== AFFILIATE_HOST ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  ) {
    return null;
  }
  if ([...url.searchParams.keys()].some((key) => SENSITIVE_QUERY_KEY_RE.test(key))) return null;
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  if (pathname === "/affiliates/search/creators/tab/registered") return "approved_creator_list";
  if (/^\/affiliates\/search\/creators\/[^/]+$/.test(pathname)) return "creator_detail";
  if (pathname === "/affiliates/search/creators") return "creator_list";
  if (/^\/affiliates\/search(?:\/|$)/.test(pathname)) return "post_search";
  if (/^\/affiliates\/generated(?:\/|$)/.test(pathname)) return "generated_list";
  return null;
}

function normalizedPostSource(post, identity, creator) {
  return {
    post_uuid: identity.uuid,
    post_public_url: identity.officialUrl,
    title: post.title == null ? null : normalizeText(post.title),
    creator_external_id: creator.externalCreatorId,
    creator_name: creator.displayName,
    price_jpy: post.price_jpy ?? null,
    affiliate_reward_rate: post.affiliate_reward_rate ?? null,
    estimated_reward_jpy: post.estimated_reward_jpy ?? null,
    media_type: post.media_type,
    video_duration_seconds: post.video_duration_seconds ?? null,
    likes: post.likes ?? null,
    affiliate_eligible: post.affiliate_eligible
  };
}

function normalizePost(post, index, bundle) {
  const reasons = exactObjectFields(post, POST_FIELDS, "POST");
  const identity = parsePostIdentity(post?.post_uuid, post?.post_public_url);
  if (identity.error) reasons.push(identity.error);
  const creator = normalizeCreatorIdentity(post || {});
  if (creator.error) reasons.push(creator.error);
  const collectedAt = isoTimestamp(post?.collected_at);
  if (!collectedAt) reasons.push("INVALID_COLLECTED_AT");
  const sourceSurface = normalizeText(post?.source_surface);
  const observedSurface = sourceSurfaceFromUrl(post?.source_page_url);
  if (!observedSurface || observedSurface !== sourceSurface) reasons.push("INVALID_SOURCE_PAGE_PROVENANCE");
  if (!PARSER_CONFIDENCE.has(post?.parser_confidence)) reasons.push("INVALID_PARSER_CONFIDENCE");
  if (!MEDIA_TYPES.has(post?.media_type)) reasons.push("INVALID_MEDIA_TYPE");
  if (typeof post?.affiliate_eligible !== "boolean") reasons.push("INVALID_AFFILIATE_ELIGIBILITY");
  const price = nullableNonNegativeInteger(post?.price_jpy, "price_jpy", reasons);
  const estimatedReward = nullableNonNegativeInteger(
    post?.estimated_reward_jpy,
    "estimated_reward_jpy",
    reasons
  );
  const rewardRate = nullableRate(post?.affiliate_reward_rate, reasons);
  const likes = nullableNonNegativeInteger(post?.likes, "likes", reasons);
  const durationSeconds = nullableNonNegativeInteger(
    post?.video_duration_seconds,
    "video_duration_seconds",
    reasons
  );
  if (estimatedReward !== null && price === null) reasons.push("ESTIMATED_REWARD_WITHOUT_PRICE");
  if (estimatedReward !== null && price !== null && estimatedReward > price) {
    reasons.push("ESTIMATED_REWARD_EXCEEDS_PRICE");
  }
  if (
    estimatedReward !== null &&
    price !== null &&
    rewardRate !== null &&
    estimatedReward > (price * rewardRate) / 100 + 1
  ) {
    reasons.push("ESTIMATED_REWARD_EXCEEDS_GROSS_RATE");
  }
  if (post?.title != null && !normalizeText(post.title)) reasons.push("EMPTY_TITLE");
  if (post?.relative_published_text && post?.published_at) {
    reasons.push("RELATIVE_TIME_MUST_NOT_SET_PUBLISHED_AT");
  }
  if (reasons.length > 0) {
    return { accepted: false, index, externalId: identity.uuid || null, reasons: [...new Set(reasons)] };
  }
  if (post.affiliate_eligible === false) {
    return { accepted: false, skipped: true, index, externalId: identity.uuid, reasons: ["AFFILIATE_INELIGIBLE"] };
  }

  const sourceRecord = normalizedPostSource(post, identity, creator);
  const sourceHash = sha256(sourceRecord);
  const coreMetadata = {
    external_post_id: identity.uuid,
    title: post.title == null ? null : normalizeText(post.title),
    official_url: identity.officialUrl,
    content_type: post.media_type,
    media_indicator: post.media_type,
    visibility: "unknown",
    price,
    currency: "JPY"
  };
  const dbRow = {
    data_source_id: null,
    creator_id: null,
    external_post_id: identity.uuid,
    source_product_id: null,
    title: coreMetadata.title,
    teaser: null,
    official_url: identity.officialUrl,
    thumbnail_url: null,
    published_at: null,
    content_type: post.media_type,
    media_indicator: post.media_type,
    sample_available: null,
    visibility: "unknown",
    price,
    currency: "JPY",
    review_status: "needs_visibility_review",
    raw_public_metadata: {},
    metadata_hash: sha256(coreMetadata),
    fetched_at: collectedAt
  };
  return {
    accepted: true,
    index,
    externalId: identity.uuid,
    duplicateComparable: sourceRecord,
    creator,
    postTarget: {
      planned_action: "UPSERT_BY_DATA_SOURCE_AND_EXTERNAL_POST_ID_DRY_RUN",
      identity: {
        data_source_key: "MYFANS",
        external_post_id: identity.uuid,
        creator_external_id: creator.externalCreatorId
      },
      db_row: dbRow,
      unresolved_foreign_keys: ["data_source_id", "creator_id"],
      unpersisted_provenance: {
        source: SOURCE_NAME,
        source_type: SOURCE_TYPE,
        collector_version: bundle.collector_version,
        importer_version: IMPORTER_VERSION,
        collected_at: collectedAt,
        source_page_url: post.source_page_url,
        source_post_uuid: identity.uuid,
        source_post_url: identity.officialUrl,
        source_hash: sourceHash,
        parser_confidence: post.parser_confidence
      },
      held_affiliate_state: {
        affiliate_enabled: true,
        affiliate_reward_rate: rewardRate,
        estimated_reward_jpy: estimatedReward
      },
      held_metrics: {
        likes,
        video_duration: post.video_duration ?? null,
        video_duration_seconds: durationSeconds
      },
      intentionally_not_stored: {
        relative_published_text: post.relative_published_text ?? null,
        displayed_affiliate_url: post.displayed_affiliate_url ? "REDACTED_PRESENT" : null,
        thumbnail_url: null,
        published_at: null
      }
    }
  };
}

function normalizeCreatorTarget(creatorState) {
  const coreMetadata = {
    external_creator_id: creatorState.externalCreatorId,
    profile_slug: creatorState.username,
    display_name: creatorState.displayName,
    official_url: creatorState.officialUrl,
    visibility: "unknown"
  };
  return {
    planned_action: "UPSERT_BY_DATA_SOURCE_AND_EXTERNAL_CREATOR_ID_DRY_RUN",
    identity: {
      data_source_key: "MYFANS",
      external_creator_id: creatorState.externalCreatorId
    },
    db_row: {
      data_source_id: null,
      external_creator_id: creatorState.externalCreatorId,
      profile_slug: creatorState.username,
      display_name: creatorState.displayName,
      official_url: creatorState.officialUrl,
      profile_image_url: null,
      bio: null,
      visibility: "unknown",
      review_status: "needs_visibility_review",
      raw_public_metadata: {},
      metadata_hash: sha256(coreMetadata),
      fetched_at: creatorState.fetchedAt
    },
    unresolved_foreign_keys: ["data_source_id"],
    identity_kind: "PROFILE_SLUG_FALLBACK",
    post_observation_count: creatorState.postCount
  };
}

function bundleErrors(bundle) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) return ["BUNDLE_NOT_OBJECT"];
  const errors = exactObjectFields(bundle, TOP_LEVEL_FIELDS, "TOP_LEVEL");
  if (bundle.schema_version !== EXPECTED_SCHEMA_VERSION) errors.push("UNSUPPORTED_SCHEMA_VERSION");
  if (!SUPPORTED_COLLECTOR_VERSIONS.includes(bundle.collector_version)) {
    errors.push("UNSUPPORTED_COLLECTOR_VERSION");
  }
  if (
    bundle.source?.system !== "MyFans Affiliate Center" ||
    bundle.source?.mode !== "RENDERED_UI_TEXT" ||
    bundle.source?.host !== AFFILIATE_HOST
  ) {
    errors.push("UNEXPECTED_SOURCE_CONTRACT");
  }
  if (!isoTimestamp(bundle.collected_at)) errors.push("INVALID_BUNDLE_COLLECTED_AT");
  if (!Array.isArray(bundle.posts)) errors.push("POSTS_NOT_ARRAY");
  if (!Array.isArray(bundle.creators)) errors.push("CREATORS_NOT_ARRAY");
  if (!Array.isArray(bundle.pages)) errors.push("PAGES_NOT_ARRAY");
  if (!Array.isArray(bundle.warnings)) errors.push("WARNINGS_NOT_ARRAY");
  else if (bundle.warnings.length > 0) errors.push("SOURCE_WARNINGS_PRESENT");
  if (Array.isArray(bundle.posts) && bundle.counts?.posts !== bundle.posts.length) {
    errors.push("POST_COUNT_MISMATCH");
  }
  if (Array.isArray(bundle.creators) && bundle.counts?.creators !== bundle.creators.length) {
    errors.push("CREATOR_COUNT_MISMATCH");
  }
  if (Array.isArray(bundle.pages) && bundle.counts?.pages_scanned !== bundle.pages.length) {
    errors.push("PAGE_COUNT_MISMATCH");
  }
  for (const path of prohibitedFieldPaths(bundle)) errors.push(`PROHIBITED_FIELD:${path}`);
  return [...new Set(errors)];
}

function reasonCounts(entries) {
  const counts = {};
  for (const entry of entries) {
    for (const reason of entry.reasons || []) counts[reason] = (counts[reason] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function nullCounts(posts) {
  const fields = [
    "title",
    "creator_username",
    "creator_profile_url",
    "price_jpy",
    "affiliate_reward_rate",
    "estimated_reward_jpy",
    "likes",
    "video_duration_seconds"
  ];
  return Object.fromEntries(
    fields.map((field) => [
      field,
      posts.filter((post) => post?.[field] == null || (typeof post[field] === "string" && !post[field].trim())).length
    ])
  );
}

export function dryRunCatalogImport(bundle, options = {}) {
  const posts = Array.isArray(bundle?.posts) ? bundle.posts : [];
  const creators = Array.isArray(bundle?.creators) ? bundle.creators : [];
  const preflightErrors = bundleErrors(bundle);
  const baseReport = {
    importer_version: IMPORTER_VERSION,
    apply: false,
    database_apply_supported: false,
    db_query_count: 0,
    db_write_count: 0,
    network_request_count: 0,
    input: {
      file_name: options.fileName || null,
      file_sha256: options.fileSha256 || null,
      schema_version: bundle?.schema_version ?? null,
      collector_version: bundle?.collector_version ?? null,
      records: posts.length,
      creator_records: creators.length,
      pages_scanned: bundle?.counts?.pages_scanned ?? null,
      warnings: Array.isArray(bundle?.warnings) ? bundle.warnings.length : null
    },
    counts: {
      input: posts.length,
      accepted: 0,
      rejected: 0,
      skipped: 0,
      duplicate_uuid: 0,
      duplicate_identical: 0,
      duplicate_conflicting: 0,
      creators_discovered: 0,
      posts_normalized: 0
    },
    null_counts: nullCounts(posts),
    field_mapping: FIELD_MAPPING,
    schema_gaps: SCHEMA_GAPS,
    validation_errors: [],
    rejection_reasons: {},
    targets: {
      myfans_creators: [],
      myfans_posts: [],
      myfans_plans: [],
      myfans_post_plans: [],
      video_source_link_evidence: []
    }
  };

  if (preflightErrors.length > 0) {
    baseReport.status = "FIX_REQUIRED";
    baseReport.normalization_pass = false;
    baseReport.validation_errors = [{ scope: "bundle", reasons: preflightErrors }];
    baseReport.rejection_reasons = reasonCounts(baseReport.validation_errors);
    return baseReport;
  }

  const seenPosts = new Map();
  const creatorStates = new Map();
  const validationErrors = [];
  const acceptedPosts = [];
  let skipped = 0;
  let duplicateUuid = 0;
  let duplicateIdentical = 0;
  let duplicateConflicting = 0;

  for (let index = 0; index < posts.length; index += 1) {
    const result = normalizePost(posts[index], index, bundle);
    if (!result.accepted) {
      if (result.skipped) skipped += 1;
      else validationErrors.push({ scope: "post", index, external_id: result.externalId, reasons: result.reasons });
      continue;
    }
    const existing = seenPosts.get(result.externalId);
    if (existing) {
      duplicateUuid += 1;
      if (stableJson(existing.duplicateComparable) === stableJson(result.duplicateComparable)) {
        duplicateIdentical += 1;
        skipped += 1;
      } else {
        duplicateConflicting += 1;
        validationErrors.push({
          scope: "post",
          index,
          external_id: result.externalId,
          reasons: ["DUPLICATE_CONFLICTING_UUID"]
        });
      }
      continue;
    }

    const creatorKey = result.creator.externalCreatorId;
    const creatorState = creatorStates.get(creatorKey);
    if (creatorState && creatorState.displayName !== result.creator.displayName) {
      validationErrors.push({
        scope: "creator",
        index,
        external_id: creatorKey,
        reasons: ["CONFLICTING_CREATOR_DISPLAY_NAME"]
      });
      continue;
    }
    if (!creatorState) {
      creatorStates.set(creatorKey, {
        ...result.creator,
        fetchedAt: result.postTarget.db_row.fetched_at,
        postCount: 1
      });
    } else {
      creatorState.fetchedAt = [creatorState.fetchedAt, result.postTarget.db_row.fetched_at].sort().at(-1);
      creatorState.postCount += 1;
    }
    seenPosts.set(result.externalId, result);
    acceptedPosts.push(result.postTarget);
  }

  for (let index = 0; index < creators.length; index += 1) {
    const errors = exactObjectFields(creators[index], CREATOR_FIELDS, "CREATOR");
    if (errors.length > 0) {
      validationErrors.push({ scope: "creator_record", index, external_id: null, reasons: errors });
    }
  }

  baseReport.counts.accepted = acceptedPosts.length;
  baseReport.counts.rejected = validationErrors.length;
  baseReport.counts.skipped = skipped;
  baseReport.counts.duplicate_uuid = duplicateUuid;
  baseReport.counts.duplicate_identical = duplicateIdentical;
  baseReport.counts.duplicate_conflicting = duplicateConflicting;
  baseReport.counts.creators_discovered = creatorStates.size;
  baseReport.counts.posts_normalized = acceptedPosts.length;
  baseReport.validation_errors = validationErrors;
  baseReport.rejection_reasons = reasonCounts(validationErrors);
  baseReport.targets.myfans_creators = [...creatorStates.values()]
    .sort((left, right) => left.externalCreatorId.localeCompare(right.externalCreatorId))
    .map(normalizeCreatorTarget);
  baseReport.targets.myfans_posts = acceptedPosts.sort((left, right) =>
    left.identity.external_post_id.localeCompare(right.identity.external_post_id)
  );
  baseReport.status = validationErrors.length === 0 ? "PASS" : "FIX_REQUIRED";
  baseReport.normalization_pass = validationErrors.length === 0;
  return baseReport;
}

export function summaryOnly(report) {
  return {
    importer_version: report.importer_version,
    status: report.status,
    normalization_pass: report.normalization_pass,
    apply: report.apply,
    database_apply_supported: report.database_apply_supported,
    db_query_count: report.db_query_count,
    db_write_count: report.db_write_count,
    network_request_count: report.network_request_count,
    input: report.input,
    counts: report.counts,
    null_counts: report.null_counts,
    target_counts: Object.fromEntries(
      Object.entries(report.targets).map(([target, rows]) => [target, rows.length])
    ),
    schema_gaps: report.schema_gaps,
    validation_errors: report.validation_errors,
    rejection_reasons: report.rejection_reasons
  };
}
