import { createHash } from "node:crypto";

const DAY_MS = 86_400_000;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export const FANZA_PRIORITY_POLICY = Object.freeze({
  version: "priority-v1",
  laneOrder: ["RECENT_POPULAR", "LATEST", "BACKFILL"],
  laneRatios: Object.freeze({ RECENT_POPULAR: 0.60, LATEST: 0.25, BACKFILL: 0.15 }),
  recentPopularMaximumAgeDays: 180,
  latestProtectionDays: 7,
});

const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
const number = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function normalizePriorityCode(value) {
  return text(value)?.toUpperCase().replace(/[^A-Z0-9]/g, "") || null;
}

export function releaseAgeDays(releaseDate, asOf) {
  const released = text(releaseDate);
  if (!released || !/^\d{4}-\d{2}-\d{2}$/.test(released)) return null;
  const releasedAt = Date.parse(`${released}T00:00:00Z`);
  const asOfAt = Date.parse(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(releasedAt) || !Number.isFinite(asOfAt)) return null;
  return Math.max(0, Math.floor((asOfAt - releasedAt) / DAY_MS));
}

export function ageBucket(ageDays) {
  if (ageDays === null) return "UNKNOWN";
  if (ageDays <= 7) return "0-7d";
  if (ageDays <= 30) return "8-30d";
  if (ageDays <= 90) return "31-90d";
  if (ageDays <= 180) return "91-180d";
  return "180+d";
}

function freshnessScore(ageDays) {
  if (ageDays === null) return -1_000;
  if (ageDays <= 7) return 1_000 - ageDays * 2;
  if (ageDays <= 30) return 850 - ageDays;
  if (ageDays <= 90) return 650 - ageDays;
  if (ageDays <= 180) return 400 - ageDays;
  return -ageDays;
}

export function officialReviewSignal(raw) {
  const review = raw?.review && typeof raw.review === "object" ? raw.review : {};
  const count = number(review.count);
  const average = number(review.average);
  if (count === null || average === null || count < 0 || average < 0 || average > 5) {
    return { count: null, average: null, label: "NONE", score: 0 };
  }
  return {
    count,
    average,
    label: `count:${count};average:${average.toFixed(2)}`,
    score: Math.min(count, 100) + Math.round(average * 10),
  };
}

function priorityScore({ ageDays, rankPosition, review }) {
  const rankScore = rankPosition === null ? 0 : Math.max(0, 600 - rankPosition);
  return freshnessScore(ageDays) + rankScore + review.score;
}

export function priorityCandidateFromRaw(raw, context) {
  const externalProductId = text(raw?.content_id) ?? text(raw?.product_id);
  const productCode = text(raw?.product_id)?.toUpperCase() ?? null;
  const releaseDate = text(raw?.date)?.slice(0, 10).replaceAll("/", "-") ?? null;
  const ageDays = releaseAgeDays(releaseDate, context.asOf);
  const review = officialReviewSignal(raw);
  const rankPosition = context.sort === "rank" ? context.position : null;
  const maker = Array.isArray(raw?.iteminfo?.maker) ? text(raw.iteminfo.maker[0]?.name) : null;
  const series = Array.isArray(raw?.iteminfo?.series) ? text(raw.iteminfo.series[0]?.name) : null;
  const payloadHash = sha256(JSON.stringify(raw));
  return {
    product_code: productCode,
    normalized_product_code: normalizePriorityCode(productCode),
    external_product_id: externalProductId,
    release_date: releaseDate,
    release_age_days: ageDays,
    release_age_bucket: ageBucket(ageDays),
    maker,
    series,
    query_sorts: [context.sort],
    official_rank_position: rankPosition,
    official_popularity_signal: rankPosition === null ? "NONE" : `rank:${rankPosition}`,
    official_review_signal: review.label,
    priority_score: priorityScore({ ageDays, rankPosition, review }),
    image_metadata_url: text(raw?.imageURL?.large) ?? text(raw?.imageURL?.list) ?? null,
    already_exists: false,
    reason: [],
    raw_provenance: {
      [context.sort]: {
        raw_payload: raw,
        raw_source_sort: context.sort,
        raw_source_position: context.position,
        payload_hash: payloadHash,
      },
    },
  };
}

function mergeRawProvenance(current, candidate) {
  if (current.external_product_id && candidate.external_product_id
    && current.external_product_id !== candidate.external_product_id) {
    throw new Error("PROVENANCE_CONFLICT_EXTERNAL_ID");
  }
  if (current.normalized_product_code && candidate.normalized_product_code
    && current.normalized_product_code !== candidate.normalized_product_code) {
    throw new Error("PROVENANCE_CONFLICT_NORMALIZED_CODE");
  }
  for (const [sort, provenance] of Object.entries(candidate.raw_provenance ?? {})) {
    const existing = current.raw_provenance?.[sort];
    if (existing && existing.payload_hash !== provenance.payload_hash) {
      throw new Error(`PROVENANCE_CONFLICT_${sort.toUpperCase()}`);
    }
    current.raw_provenance ??= {};
    current.raw_provenance[sort] ??= provenance;
  }
}

export function mergePriorityCandidates(inputs) {
  const merged = [];
  const byExternalId = new Map();
  const byCode = new Map();
  for (const candidate of inputs) {
    const current = (candidate.external_product_id && byExternalId.get(candidate.external_product_id))
      || (candidate.normalized_product_code && byCode.get(candidate.normalized_product_code));
    if (!current) {
      const added = {
        ...candidate,
        query_sorts: [...candidate.query_sorts],
        raw_provenance: { ...candidate.raw_provenance },
      };
      merged.push(added);
      if (added.external_product_id) byExternalId.set(added.external_product_id, added);
      if (added.normalized_product_code) byCode.set(added.normalized_product_code, added);
      continue;
    }
    mergeRawProvenance(current, candidate);
    current.query_sorts = [...new Set([...current.query_sorts, ...candidate.query_sorts])].sort();
    if (current.official_review_signal === "NONE" && candidate.official_review_signal !== "NONE") {
      current.official_review_signal = candidate.official_review_signal;
    }
    if (candidate.official_rank_position !== null
      && (current.official_rank_position === null
        || candidate.official_rank_position < current.official_rank_position)) {
      current.official_rank_position = candidate.official_rank_position;
      current.official_popularity_signal = candidate.official_popularity_signal;
      current.priority_score = candidate.priority_score;
    }
  }
  return merged;
}

const compareText = (a, b) => String(a ?? "").localeCompare(String(b ?? ""), "en");
const compareCandidate = (a, b) => b.priority_score - a.priority_score
  || compareText(b.release_date, a.release_date)
  || compareText(a.normalized_product_code, b.normalized_product_code)
  || compareText(a.external_product_id, b.external_product_id);

export function selectPriorityCandidates({ rankCandidates, latestCandidates, backfillCandidates, targetSize }) {
  if (!Number.isInteger(targetSize) || targetSize < 1 || targetSize > 1_000) {
    throw new Error("PRIORITY_TARGET_SIZE_1_TO_1000_REQUIRED");
  }
  const targets = {
    RECENT_POPULAR: Math.floor(targetSize * FANZA_PRIORITY_POLICY.laneRatios.RECENT_POPULAR),
    LATEST: Math.floor(targetSize * FANZA_PRIORITY_POLICY.laneRatios.LATEST),
  };
  targets.BACKFILL = targetSize - targets.RECENT_POPULAR - targets.LATEST;
  const chosen = [];
  const selectedIds = new Set();
  const selectedCodes = new Set();
  const addLane = (candidates, lane, limit, predicate = () => true) => {
    for (const candidate of [...candidates].sort(compareCandidate)) {
      if (chosen.filter((row) => row.lane === lane).length >= limit) break;
      if (!predicate(candidate)) continue;
      if (candidate.external_product_id && selectedIds.has(candidate.external_product_id)) continue;
      if (candidate.normalized_product_code && selectedCodes.has(candidate.normalized_product_code)) continue;
      const reason = lane === "RECENT_POPULAR"
        ? ["OFFICIAL_RANK_ORDER", "WITHIN_180_DAYS"]
        : lane === "LATEST"
          ? [candidate.release_age_days !== null && candidate.release_age_days <= 7
            ? "LATEST_0_7_DAY_PROTECTION"
            : "LATEST_DATE_ORDER"]
          : ["DURABLE_BACKFILL_FRONTIER"];
      const canonicalSort = lane === "RECENT_POPULAR" ? "rank" : lane === "LATEST" ? "date" : "backfill";
      const provenance = candidate.raw_provenance?.[canonicalSort];
      if (!provenance) throw new Error(`PRIORITY_CANONICAL_RAW_MISSING_${canonicalSort.toUpperCase()}`);
      chosen.push({
        ...candidate,
        lane,
        reason,
        raw_payload: provenance.raw_payload,
        raw_source_sort: provenance.raw_source_sort,
        raw_source_position: provenance.raw_source_position,
        payload_hash: provenance.payload_hash,
      });
      if (candidate.external_product_id) selectedIds.add(candidate.external_product_id);
      if (candidate.normalized_product_code) selectedCodes.add(candidate.normalized_product_code);
    }
  };
  addLane(rankCandidates, "RECENT_POPULAR", targets.RECENT_POPULAR, (candidate) =>
    candidate.official_rank_position !== null
      && candidate.release_age_days !== null
      && candidate.release_age_days <= FANZA_PRIORITY_POLICY.recentPopularMaximumAgeDays);
  addLane(latestCandidates, "LATEST", targets.LATEST);
  addLane(backfillCandidates, "BACKFILL", targets.BACKFILL);
  if (chosen.length < targetSize) {
    addLane(latestCandidates, "LATEST", targets.LATEST + (targetSize - chosen.length));
  }
  const ordered = [...chosen].sort(compareCandidate);
  return { targets, candidates: ordered.map((candidate, index) => ({ ...candidate, priority_position: index + 1 })) };
}

export function lightweightPriorityCandidate(candidate) {
  const {
    raw_payload: _rawPayload,
    raw_provenance: _rawProvenance,
    payload_hash: _payloadHash,
    raw_source_sort: _rawSourceSort,
    raw_source_position: _rawSourcePosition,
    ...lightweight
  } = candidate;
  return lightweight;
}

export function markExistingCandidates(candidates, existingExternalIds, existingCodes) {
  return candidates.map((candidate) => {
    const alreadyExists = (candidate.external_product_id && existingExternalIds.has(candidate.external_product_id))
      || (candidate.normalized_product_code && existingCodes.has(candidate.normalized_product_code));
    return {
      ...candidate,
      already_exists: Boolean(alreadyExists),
      reason: alreadyExists ? [...candidate.reason, "EXACT_DB_MATCH"] : candidate.reason,
    };
  });
}

export function distributionMetrics(candidates) {
  const ages = candidates.map((candidate) => candidate.release_age_days).filter(Number.isFinite).sort((a, b) => a - b);
  const percentile = (ratio) => ages.length ? ages[Math.min(ages.length - 1, Math.ceil(ages.length * ratio) - 1)] : null;
  return {
    count: candidates.length,
    median_release_age_days: percentile(0.5),
    p90_release_age_days: percentile(0.9),
    recent_30_days: candidates.filter((candidate) => candidate.release_age_days !== null && candidate.release_age_days <= 30).length,
    recent_90_days: candidates.filter((candidate) => candidate.release_age_days !== null && candidate.release_age_days <= 90).length,
    official_popularity_coverage: candidates.length
      ? candidates.filter((candidate) => candidate.official_rank_position !== null).length / candidates.length
      : 0,
    existing_count: candidates.filter((candidate) => candidate.already_exists).length,
  };
}
