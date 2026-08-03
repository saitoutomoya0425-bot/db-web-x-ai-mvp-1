const MODES = new Set(["SAMPLE", "PACKAGE_RIGHT", "PACKAGE_FULL", "PACKAGE_CENTER"]);

export const PHASE4E_SAMPLE_RANKING_POLICY = Object.freeze({
  sample_vs_package_margin: 12,
  candidate_margin: 8,
  auto_apply: false,
  center_requires_invalid_sides: true,
  scene_crop_allowed: false,
});

const finite = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const bounded = (value, minimum = 0, maximum = 20) =>
  Math.min(maximum, Math.max(minimum, finite(value)));

function candidateIdentity(candidate) {
  return [
    candidate.code,
    candidate.mode,
    candidate.source_id,
    candidate.source_path_or_url,
    candidate.source_hash,
  ].join("\u0000");
}

function assertCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") {
    throw new Error("PHASE4E_RANKING:INVALID_CANDIDATE");
  }
  for (const field of ["code", "mode", "source_id", "source_path_or_url", "source_hash"]) {
    if (typeof candidate[field] !== "string" || !candidate[field].trim()) {
      throw new Error(`PHASE4E_RANKING:MISSING_${field.toUpperCase()}`);
    }
  }
  if (!MODES.has(candidate.mode)) {
    throw new Error(`PHASE4E_RANKING:UNSUPPORTED_MODE:${candidate.mode}`);
  }
}

export function scorePhase4ECandidate(candidate) {
  assertCandidate(candidate);
  const reasonCodes = [];
  const positive =
    bounded(candidate.visual_quality_score) +
    bounded(candidate.work_information_score) +
    bounded(candidate.identity_and_context_score) +
    bounded(candidate.representativeness_score) +
    bounded(candidate.card_subject_retention_score) +
    bounded(candidate.subject_scale_score) +
    bounded(candidate.orientation_score) +
    bounded(candidate.card_composition_score);
  let penalty = 0;

  const penalize = (condition, amount, code) => {
    if (!condition) return;
    penalty += amount;
    reasonCodes.push(code);
  };

  penalize(candidate.face_or_primary_subject_lost === true, 45, "CARD_PRIMARY_SUBJECT_LOST");
  penalize(candidate.subject_too_small === true, 28, "CARD_SUBJECT_TOO_SMALL");
  penalize(candidate.local_or_partial_composition === true, 32, "LOCAL_OR_PARTIAL_COMPOSITION");
  penalize(candidate.orientation_invalid === true, 45, "INVALID_ORIENTATION");
  penalize(candidate.duplicate_or_near_duplicate === true, 18, "DUPLICATE_OR_NEAR_DUPLICATE");
  penalize(candidate.generic_scene === true, 18, "GENERIC_SCENE");
  penalty += bounded(candidate.whitespace_penalty, 0, 30);
  penalty += bounded(candidate.card_context_loss_penalty, 0, 40);
  if (finite(candidate.whitespace_penalty) > 0) reasonCodes.push("EXCESSIVE_WHITESPACE");
  if (finite(candidate.card_context_loss_penalty) > 0) reasonCodes.push("CARD_CONTEXT_LOSS");

  if (candidate.mode === "PACKAGE_CENTER" && candidate.sides_invalid !== true) {
    penalty += 35;
    reasonCodes.push("CENTER_WITHOUT_INVALID_SIDES");
  }

  return Object.freeze({
    ...candidate,
    score: Number((positive - penalty).toFixed(2)),
    positive_score: Number(positive.toFixed(2)),
    penalty_score: Number(penalty.toFixed(2)),
    reason_codes: Object.freeze(reasonCodes),
  });
}

function packageFallback(scored) {
  const right = scored.find((candidate) => candidate.mode === "PACKAGE_RIGHT");
  const full = scored.find((candidate) => candidate.mode === "PACKAGE_FULL");
  const center = scored.find(
    (candidate) => candidate.mode === "PACKAGE_CENTER" && candidate.sides_invalid === true,
  );
  if (right && right.right_important_information_loss !== true) return right;
  if (full) return full;
  if (right) return right;
  return center ?? null;
}

export function rankPhase4ECandidates({ candidates, labels = [] }) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return Object.freeze({
      classification: "NON_RENDERABLE",
      selected: null,
      runner_up: null,
      confidence: "none",
      score_delta: null,
      reason_codes: Object.freeze(["NO_CANDIDATES"]),
      needs_user_review: false,
      auto_apply: false,
    });
  }
  const code = candidates[0]?.code;
  for (const candidate of candidates) {
    assertCandidate(candidate);
    if (candidate.code !== code) throw new Error("PHASE4E_RANKING:MIXED_PRODUCT_CODES");
  }

  const relevantLabels = labels.filter((label) => label.code === code);
  const negative = new Set(
    relevantLabels
      .filter((label) => label.label === "NEGATIVE")
      .map(candidateIdentity),
  );
  const positives = relevantLabels.filter((label) => label.label === "POSITIVE");
  if (positives.length > 1) throw new Error(`PHASE4E_RANKING:MULTIPLE_POSITIVES:${code}`);

  const scored = candidates
    .map(scorePhase4ECandidate)
    .map((candidate) => Object.freeze({
      ...candidate,
      hard_rejected: negative.has(candidateIdentity(candidate)),
    }))
    .sort((left, right) => right.score - left.score || left.source_id.localeCompare(right.source_id, "en"));

  if (positives.length === 1) {
    const approvedIdentity = candidateIdentity(positives[0]);
    const selected = scored.find((candidate) => candidateIdentity(candidate) === approvedIdentity);
    if (!selected) throw new Error(`PHASE4E_RANKING:POSITIVE_CANDIDATE_MISSING:${code}`);
    if (selected.hard_rejected) throw new Error(`PHASE4E_RANKING:POSITIVE_NEGATIVE_CONFLICT:${code}`);
    const runnerUp = scored.find((candidate) => candidate !== selected && !candidate.hard_rejected) ?? null;
    return Object.freeze({
      classification: "CURRENT_OK",
      selected,
      runner_up: runnerUp,
      confidence: "human",
      score_delta: runnerUp ? Number((selected.score - runnerUp.score).toFixed(2)) : null,
      reason_codes: Object.freeze(["HUMAN_POSITIVE_LABEL", "CARD_7_10_REVIEWED"]),
      needs_user_review: false,
      auto_apply: false,
    });
  }

  const eligible = scored.filter((candidate) => !candidate.hard_rejected);
  if (!eligible.length) {
    return Object.freeze({
      classification: "NEEDS_USER_REVIEW",
      selected: null,
      runner_up: null,
      confidence: "low",
      score_delta: null,
      reason_codes: Object.freeze(["ALL_CANDIDATES_REJECTED"]),
      needs_user_review: true,
      auto_apply: false,
    });
  }

  const samples = eligible.filter((candidate) => candidate.mode === "SAMPLE");
  const bestSample = samples[0] ?? null;
  const sampleRunnerUp = samples[1] ?? null;
  const packageCandidate = packageFallback(eligible);
  const samplePackageDelta = bestSample && packageCandidate
    ? bestSample.score - packageCandidate.score
    : bestSample ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  const sampleDelta = bestSample && sampleRunnerUp
    ? bestSample.score - sampleRunnerUp.score
    : Number.POSITIVE_INFINITY;
  const sampleIsClear = Boolean(
    bestSample &&
    samplePackageDelta >= PHASE4E_SAMPLE_RANKING_POLICY.sample_vs_package_margin &&
    sampleDelta >= PHASE4E_SAMPLE_RANKING_POLICY.candidate_margin &&
    !bestSample.reason_codes.some((code) => [
      "CARD_PRIMARY_SUBJECT_LOST",
      "CARD_SUBJECT_TOO_SMALL",
      "LOCAL_OR_PARTIAL_COMPOSITION",
      "INVALID_ORIENTATION",
      "CARD_CONTEXT_LOSS",
    ].includes(code)),
  );

  const selected = sampleIsClear ? bestSample : packageCandidate ?? bestSample;
  const runnerUp = eligible.find((candidate) => candidate !== selected) ?? null;
  const scoreDelta = selected && runnerUp
    ? Number((selected.score - runnerUp.score).toFixed(2))
    : null;
  const ambiguous = Boolean(
    !selected ||
    selected?.mode === "PACKAGE_CENTER" ||
    (bestSample && packageCandidate && Math.abs(samplePackageDelta) < PHASE4E_SAMPLE_RANKING_POLICY.sample_vs_package_margin) ||
    (bestSample && sampleRunnerUp && sampleDelta < PHASE4E_SAMPLE_RANKING_POLICY.candidate_margin),
  );

  return Object.freeze({
    classification: ambiguous
      ? "NEEDS_USER_REVIEW"
      : selected?.mode === "SAMPLE"
        ? "HIGH_CONFIDENCE_SAMPLE"
        : selected?.mode === "PACKAGE_FULL"
          ? "PACKAGE_FULL_PREFERRED"
          : "PACKAGE_RIGHT_PREFERRED",
    selected: selected ?? null,
    runner_up: runnerUp,
    confidence: ambiguous ? "low" : "high",
    score_delta: scoreDelta,
    sample_vs_package_margin: Number.isFinite(samplePackageDelta)
      ? Number(samplePackageDelta.toFixed(2))
      : null,
    reason_codes: Object.freeze([
      sampleIsClear ? "SAMPLE_CLEARLY_BETTER" : "PACKAGE_OR_REVIEW_GATE",
      ...(ambiguous ? ["CLOSE_OR_CONTRADICTORY_RANKING"] : []),
    ]),
    needs_user_review: ambiguous,
    auto_apply: false,
  });
}
