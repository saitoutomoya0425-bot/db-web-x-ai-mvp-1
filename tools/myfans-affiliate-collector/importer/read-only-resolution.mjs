import { createHash } from "node:crypto";

export const RESOLVER_VERSION = "myfans-read-only-resolution-v1";

const CREATOR_STATUS = Object.freeze({
  EXISTING_EXACT: "EXISTING_EXACT",
  NEW: "NEW",
  AMBIGUOUS: "AMBIGUOUS",
  CONFLICT: "CONFLICT"
});

const POST_STATUS = Object.freeze({
  NEW: "NEW",
  EXISTING_IDENTICAL: "EXISTING_IDENTICAL",
  EXISTING_UPDATE_NEEDED: "EXISTING_UPDATE_NEEDED",
  CONFLICT: "CONFLICT"
});

const CREATOR_COMPARE_FIELDS = Object.freeze(["profile_slug", "display_name"]);
const POST_COMPARE_FIELDS = Object.freeze([
  "title",
  "content_type",
  "media_indicator",
  "price",
  "currency"
]);

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function token(value, prefix) {
  return `${prefix}:${sha256(value).slice(0, 16)}`;
}

function normalizedText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedSlug(value) {
  const text = normalizedText(value);
  return text ? text.toLowerCase() : null;
}

function canonicalMyFansUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !["myfans.jp", "www.myfans.jp"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return `https://myfans.jp${pathname}`;
  } catch {
    return null;
  }
}

function comparableNumber(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : value;
}

function sameValue(field, left, right) {
  if (field === "price") return comparableNumber(left) === comparableNumber(right);
  if (field === "profile_slug") return normalizedSlug(left) === normalizedSlug(right);
  return left === right;
}

function countsFor(items, statuses) {
  return Object.fromEntries(
    statuses.map((status) => [status, items.filter((item) => item.status === status).length])
  );
}

function dataSourceResolution(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return {
      status: "NOT_FOUND",
      blocking_reason: "MYFANS_DATA_SOURCE_NOT_FOUND",
      candidate_count: 0,
      unique_contract: "data_sources.name UNIQUE"
    };
  }
  if (candidates.length !== 1) {
    return {
      status: "AMBIGUOUS",
      blocking_reason: "MULTIPLE_MYFANS_DATA_SOURCES",
      candidate_count: candidates.length,
      unique_contract: "data_sources.name UNIQUE"
    };
  }
  const row = candidates[0];
  if (!row?.id || !normalizedText(row.name) || !normalizedText(row.source_type)) {
    return {
      status: "INVALID",
      blocking_reason: "INVALID_MYFANS_DATA_SOURCE_ROW",
      candidate_count: 1,
      unique_contract: "data_sources.name UNIQUE"
    };
  }
  return {
    status: "RESOLVED",
    candidate_count: 1,
    id_hash: token(row.id, "data-source"),
    canonical_name: row.name,
    source_type: row.source_type,
    is_active: row.is_active === true,
    unique_contract: "data_sources.name UNIQUE",
    internal_id: row.id
  };
}

function creatorMatchReasons(target, row) {
  const reasons = [];
  if (row.external_creator_id === target.db_row.external_creator_id) reasons.push("EXTERNAL_CREATOR_ID");
  if (
    normalizedSlug(row.profile_slug) &&
    normalizedSlug(row.profile_slug) === normalizedSlug(target.db_row.profile_slug)
  ) {
    reasons.push("PROFILE_SLUG");
  }
  const existingUrl = canonicalMyFansUrl(row.official_url);
  const targetUrl = canonicalMyFansUrl(target.db_row.official_url);
  if (existingUrl && existingUrl === targetUrl) reasons.push("CANONICAL_PROFILE_URL");
  return reasons;
}

function creatorIdentityConflicts(target, row) {
  const conflicts = [];
  const desiredSlug = normalizedSlug(target.db_row.profile_slug);
  const existingSlug = normalizedSlug(row.profile_slug);
  const desiredUrl = canonicalMyFansUrl(target.db_row.official_url);
  const existingUrl = canonicalMyFansUrl(row.official_url);
  if (existingSlug && existingSlug !== desiredSlug) conflicts.push("PROFILE_SLUG_MISMATCH");
  if (existingUrl && desiredUrl && existingUrl !== desiredUrl) conflicts.push("PROFILE_URL_MISMATCH");
  if (
    normalizedText(row.external_creator_id).startsWith("profile_slug:") &&
    row.external_creator_id !== target.db_row.external_creator_id
  ) {
    conflicts.push("FALLBACK_EXTERNAL_ID_MISMATCH");
  }
  return conflicts;
}

function classifyCreators(targets, existingRows) {
  const items = [];
  const internalMapping = new Map();
  const targetMapping = new Map();

  for (const target of targets) {
    const identity = target.db_row.external_creator_id;
    const identityHash = token(identity, "creator");
    const matches = existingRows
      .map((row) => ({ row, matchReasons: creatorMatchReasons(target, row) }))
      .filter((candidate) => candidate.matchReasons.length > 0);

    if (matches.length === 0) {
      const temporaryKey = token(identity, "new-creator");
      const item = {
        identity_hash: identityHash,
        status: CREATOR_STATUS.NEW,
        match_basis: [],
        changed_fields: [],
        planned_action: "INSERT",
        temporary_key: temporaryKey,
        target
      };
      items.push(item);
      internalMapping.set(identity, temporaryKey);
      targetMapping.set(identity, item);
      continue;
    }

    const distinctIds = new Set(matches.map(({ row }) => row.id));
    if (distinctIds.size !== 1) {
      const item = {
        identity_hash: identityHash,
        status: CREATOR_STATUS.AMBIGUOUS,
        match_basis: [...new Set(matches.flatMap((match) => match.matchReasons))].sort(),
        candidate_count: distinctIds.size,
        changed_fields: [],
        planned_action: "BLOCK",
        target
      };
      items.push(item);
      targetMapping.set(identity, item);
      continue;
    }

    const candidate = matches[0].row;
    const conflicts = creatorIdentityConflicts(target, candidate);
    if (conflicts.length > 0) {
      const item = {
        identity_hash: identityHash,
        status: CREATOR_STATUS.CONFLICT,
        match_basis: [...new Set(matches.flatMap((match) => match.matchReasons))].sort(),
        conflict_reasons: conflicts,
        changed_fields: [],
        planned_action: "BLOCK",
        target
      };
      items.push(item);
      targetMapping.set(identity, item);
      continue;
    }

    const changedFields = CREATOR_COMPARE_FIELDS.filter((field) => {
      if (field === "profile_slug" && rowNullish(candidate[field])) return true;
      return !sameValue(field, candidate[field], target.db_row[field]);
    });
    const item = {
      identity_hash: identityHash,
      status: CREATOR_STATUS.EXISTING_EXACT,
      match_basis: [...new Set(matches.flatMap((match) => match.matchReasons))].sort(),
      changed_fields: changedFields,
      planned_action: changedFields.length > 0 ? "UPDATE" : "NO_OP",
      existing_row: candidate,
      target
    };
    items.push(item);
    internalMapping.set(identity, candidate.id);
    targetMapping.set(identity, item);
  }
  return { items, internalMapping, targetMapping };
}

function rowNullish(value) {
  return value == null || (typeof value === "string" && !value.trim());
}

function classifyPosts(targets, existingRows, creatorResolution) {
  const items = [];
  for (const target of targets) {
    const externalId = target.db_row.external_post_id;
    const identityHash = token(externalId, "post");
    const matches = existingRows.filter((row) => row.external_post_id === externalId);
    const creatorExternalId = target.identity.creator_external_id;
    const creatorItem = creatorResolution.targetMapping.get(creatorExternalId);
    const resolvedCreatorId = creatorResolution.internalMapping.get(creatorExternalId);

    if (!creatorItem || [CREATOR_STATUS.AMBIGUOUS, CREATOR_STATUS.CONFLICT].includes(creatorItem.status)) {
      items.push({
        identity_hash: identityHash,
        status: POST_STATUS.CONFLICT,
        conflict_reasons: ["CREATOR_IDENTITY_UNRESOLVED"],
        changed_fields: [],
        planned_action: "BLOCK",
        target
      });
      continue;
    }
    if (matches.length > 1) {
      items.push({
        identity_hash: identityHash,
        status: POST_STATUS.CONFLICT,
        conflict_reasons: ["MULTIPLE_ROWS_FOR_POST_UUID"],
        changed_fields: [],
        planned_action: "BLOCK",
        target
      });
      continue;
    }
    if (matches.length === 0) {
      items.push({
        identity_hash: identityHash,
        status: POST_STATUS.NEW,
        changed_fields: [],
        planned_action: "INSERT",
        resolved_creator_key: resolvedCreatorId,
        target
      });
      continue;
    }

    const existing = matches[0];
    const conflictReasons = [];
    if (creatorItem.status === CREATOR_STATUS.NEW || existing.creator_id !== resolvedCreatorId) {
      conflictReasons.push("CREATOR_RELATION_MISMATCH");
    }
    const existingUrl = canonicalMyFansUrl(existing.official_url);
    const targetUrl = canonicalMyFansUrl(target.db_row.official_url);
    if (!existingUrl || existingUrl !== targetUrl) conflictReasons.push("POST_URL_MISMATCH");
    if (conflictReasons.length > 0) {
      items.push({
        identity_hash: identityHash,
        status: POST_STATUS.CONFLICT,
        conflict_reasons: conflictReasons,
        changed_fields: [],
        planned_action: "BLOCK",
        target
      });
      continue;
    }

    const changedFields = POST_COMPARE_FIELDS.filter(
      (field) => !sameValue(field, existing[field], target.db_row[field])
    );
    const status =
      changedFields.length > 0
        ? POST_STATUS.EXISTING_UPDATE_NEEDED
        : POST_STATUS.EXISTING_IDENTICAL;
    items.push({
      identity_hash: identityHash,
      status,
      changed_fields: changedFields,
      planned_action: changedFields.length > 0 ? "UPDATE" : "NO_OP",
      existing_row: existing,
      resolved_creator_key: resolvedCreatorId,
      target
    });
  }
  return items;
}

function publicCreatorItem(item) {
  return {
    identity_hash: item.identity_hash,
    status: item.status,
    match_basis: item.match_basis || [],
    candidate_count: item.candidate_count,
    conflict_reasons: item.conflict_reasons || [],
    changed_fields: item.changed_fields,
    planned_action: item.planned_action,
    temporary_key: item.temporary_key || undefined
  };
}

function publicPostItem(item) {
  return {
    identity_hash: item.identity_hash,
    status: item.status,
    conflict_reasons: item.conflict_reasons || [],
    changed_fields: item.changed_fields,
    planned_action: item.planned_action
  };
}

function planCounts(creatorItems, postItems) {
  return {
    planned_creator_inserts: creatorItems.filter((item) => item.planned_action === "INSERT").length,
    planned_creator_updates: creatorItems.filter((item) => item.planned_action === "UPDATE").length,
    planned_post_inserts: postItems.filter((item) => item.planned_action === "INSERT").length,
    planned_post_updates: postItems.filter((item) => item.planned_action === "UPDATE").length,
    planned_no_ops:
      creatorItems.filter((item) => item.planned_action === "NO_OP").length +
      postItems.filter((item) => item.planned_action === "NO_OP").length
  };
}

function applyInMemory(snapshot, dataSourceId, creatorItems, postItems) {
  const creators = structuredClone(snapshot.creators || []);
  const posts = structuredClone(snapshot.posts || []);
  const creatorIds = new Map();

  for (const item of creatorItems) {
    const externalId = item.target.db_row.external_creator_id;
    if (item.planned_action === "INSERT") {
      const id = item.temporary_key;
      creators.push({ ...structuredClone(item.target.db_row), id, data_source_id: dataSourceId });
      creatorIds.set(externalId, id);
    } else if (item.existing_row) {
      creatorIds.set(externalId, item.existing_row.id);
      if (item.planned_action === "UPDATE") {
        const row = creators.find((candidate) => candidate.id === item.existing_row.id);
        for (const field of item.changed_fields) row[field] = item.target.db_row[field];
        row.metadata_hash = item.target.db_row.metadata_hash;
        row.fetched_at = item.target.db_row.fetched_at;
      }
    }
  }

  for (const item of postItems) {
    const externalId = item.target.db_row.external_post_id;
    const creatorId = creatorIds.get(item.target.identity.creator_external_id);
    if (item.planned_action === "INSERT") {
      posts.push({
        ...structuredClone(item.target.db_row),
        id: token(externalId, "new-post"),
        data_source_id: dataSourceId,
        creator_id: creatorId
      });
    } else if (item.planned_action === "UPDATE") {
      const row = posts.find((candidate) => candidate.id === item.existing_row.id);
      for (const field of item.changed_fields) row[field] = item.target.db_row[field];
      row.metadata_hash = item.target.db_row.metadata_hash;
      row.fetched_at = item.target.db_row.fetched_at;
    }
  }
  return { creators, posts };
}

function classify(dryRunReport, snapshot, dataSource) {
  const creatorResolution = classifyCreators(
    dryRunReport.targets.myfans_creators,
    snapshot.creators || []
  );
  const postItems = classifyPosts(
    dryRunReport.targets.myfans_posts,
    snapshot.posts || [],
    creatorResolution
  );
  return {
    creatorItems: creatorResolution.items,
    postItems,
    dataSource
  };
}

function membershipHash(items) {
  return sha256(
    items
      .map((item) => `${item.identity_hash}:${item.status}:${item.planned_action}`)
      .sort()
      .join("\n")
  );
}

export function resolveStagingPlan(dryRunReport, snapshot = {}, options = {}) {
  const queryCount = Number.isInteger(options.dbQueryCount) ? options.dbQueryCount : 0;
  const base = {
    resolver_version: RESOLVER_VERSION,
    apply: false,
    database_mode: "SELECT_ONLY",
    db_query_count: queryCount,
    db_write_count: 0,
    myfans_request_count: 0,
    source_input_hash: dryRunReport?.input?.file_sha256 || null,
    blocking_reasons: []
  };
  if (!dryRunReport?.normalization_pass) {
    return {
      ...base,
      status: "BLOCKED",
      blocking_reasons: ["NORMALIZATION_NOT_PASSED"],
      data_source: { status: "NOT_EVALUATED" }
    };
  }

  const dataSource = dataSourceResolution(snapshot.dataSourceCandidates || []);
  const publicDataSource = { ...dataSource };
  delete publicDataSource.internal_id;
  if (dataSource.status !== "RESOLVED") {
    return {
      ...base,
      status: "BLOCKED",
      blocking_reasons: [dataSource.blocking_reason],
      data_source: publicDataSource
    };
  }

  const first = classify(dryRunReport, snapshot, dataSource);
  const creatorCounts = countsFor(first.creatorItems, Object.values(CREATOR_STATUS));
  const postCounts = countsFor(first.postItems, Object.values(POST_STATUS));
  const plan = planCounts(first.creatorItems, first.postItems);
  const ambiguousCount = creatorCounts.AMBIGUOUS;
  const conflictCount = creatorCounts.CONFLICT + postCounts.CONFLICT;
  const blockingReasons = [];
  if (ambiguousCount > 0) blockingReasons.push("CREATOR_IDENTITY_AMBIGUOUS");
  if (conflictCount > 0) blockingReasons.push("IDENTITY_OR_RELATION_CONFLICT");

  let secondRun = {
    simulated: false,
    pass: false,
    reason: "BLOCKED_FIRST_RUN"
  };
  if (blockingReasons.length === 0) {
    const simulatedSnapshot = applyInMemory(
      snapshot,
      dataSource.internal_id,
      first.creatorItems,
      first.postItems
    );
    const second = classify(
      dryRunReport,
      {
        dataSourceCandidates: snapshot.dataSourceCandidates,
        ...simulatedSnapshot
      },
      dataSource
    );
    const secondCreatorCounts = countsFor(second.creatorItems, Object.values(CREATOR_STATUS));
    const secondPostCounts = countsFor(second.postItems, Object.values(POST_STATUS));
    const secondPlan = planCounts(second.creatorItems, second.postItems);
    const pass =
      secondPlan.planned_creator_inserts === 0 &&
      secondPlan.planned_creator_updates === 0 &&
      secondPlan.planned_post_inserts === 0 &&
      secondPlan.planned_post_updates === 0 &&
      secondCreatorCounts.AMBIGUOUS === 0 &&
      secondCreatorCounts.CONFLICT === 0 &&
      secondPostCounts.CONFLICT === 0 &&
      secondPostCounts.EXISTING_IDENTICAL === dryRunReport.targets.myfans_posts.length;
    secondRun = {
      simulated: true,
      pass,
      creator_inserts: secondPlan.planned_creator_inserts,
      creator_updates: secondPlan.planned_creator_updates,
      post_inserts: secondPlan.planned_post_inserts,
      post_updates: secondPlan.planned_post_updates,
      conflicts: secondCreatorCounts.CONFLICT + secondPostCounts.CONFLICT,
      ambiguous: secondCreatorCounts.AMBIGUOUS,
      no_ops: secondPlan.planned_no_ops,
      creator_resolution: secondCreatorCounts,
      post_resolution: secondPostCounts
    };
    if (!pass) blockingReasons.push("SECOND_RUN_NOT_IDEMPOTENT");
  }

  const publicCreatorItems = first.creatorItems.map(publicCreatorItem);
  const publicPostItems = first.postItems.map(publicPostItem);
  return {
    ...base,
    status: blockingReasons.length === 0 ? "READY" : "BLOCKED",
    blocking_reasons: blockingReasons,
    data_source: publicDataSource,
    creator_resolution: creatorCounts,
    post_resolution: postCounts,
    planned_mutations: plan,
    ambiguous_count: ambiguousCount,
    conflict_count: conflictCount,
    second_run: secondRun,
    evidence: {
      creator_membership_sha256: membershipHash(publicCreatorItems),
      post_membership_sha256: membershipHash(publicPostItems),
      identifiers: "SHA256_PREFIX_ONLY"
    },
    details: {
      creators: publicCreatorItems,
      posts: publicPostItems
    }
  };
}

export function resolutionSummary(report) {
  return {
    resolver_version: report.resolver_version,
    status: report.status,
    apply: report.apply,
    database_mode: report.database_mode,
    db_query_count: report.db_query_count,
    db_write_count: report.db_write_count,
    myfans_request_count: report.myfans_request_count,
    source_input_hash: report.source_input_hash,
    data_source: report.data_source,
    creator_resolution: report.creator_resolution,
    post_resolution: report.post_resolution,
    planned_mutations: report.planned_mutations,
    ambiguous_count: report.ambiguous_count,
    conflict_count: report.conflict_count,
    second_run: report.second_run,
    evidence: report.evidence,
    blocking_reasons: report.blocking_reasons
  };
}
