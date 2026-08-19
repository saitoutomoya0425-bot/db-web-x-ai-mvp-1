export const THUMBNAIL_CANDIDATE_AUTO_SCORE = 78;
export const THUMBNAIL_CANDIDATE_REVIEW_GAP = 12;
export const FULL_RIGHT_REVIEW_GAP = 32;

export function hasThumbnailCandidateRisk(candidate) {
  return Boolean(
    candidate?.excluded
      || candidate?.review
      || candidate?.flags?.bodyPartOrClose
      || candidate?.flags?.faceOnlyLike
      || candidate?.flags?.plainScene
      || candidate?.flags?.cropLooksCut
      || candidate?.components?.bodyPart > 0
      || candidate?.components?.faceOnly > 0
      || candidate?.components?.scenePhoto >= 40
      || candidate?.reasons?.some((reason) =>
        /body_part|face_only|plain_scene|person_or_text_cut|low_resolution/.test(reason)),
  );
}

export function classifyThumbnailCandidate({
  best,
  runnerUp = null,
  rightCandidate = null,
  sampleCandidateAvailable = false,
  centerEligible = true,
}) {
  if (!best) {
    return Object.freeze({
      classification: "C",
      confidence: "none",
      risk: "reject",
      needs_review: true,
      reason_codes: ["NO_CANDIDATE"],
    });
  }
  const delta = runnerUp ? best.score - runnerUp.score : null;
  const fullRightDelta = best.type === "dvd_full" && rightCandidate
    ? best.score - rightCandidate.score
    : null;
  const reasonCodes = [];
  if (hasThumbnailCandidateRisk(best)) reasonCodes.push("CANDIDATE_RISK");
  if (best.score < THUMBNAIL_CANDIDATE_AUTO_SCORE) reasonCodes.push("BELOW_AUTO_SCORE");
  if (reasonCodes.length > 0) {
    return Object.freeze({
      classification: "C",
      confidence: "low",
      risk: "reject",
      needs_review: true,
      score_delta: delta,
      full_right_delta: fullRightDelta,
      reason_codes: reasonCodes,
    });
  }
  if (best.type === "sample") reasonCodes.push("SAMPLE_REQUIRES_REVIEW");
  if (best.type === "dvd_center") reasonCodes.push("CENTER_REQUIRES_REVIEW");
  if (best.type === "dvd_right" && sampleCandidateAvailable) {
    reasonCodes.push("RIGHT_WITH_SAMPLE_CANDIDATES_REQUIRES_REVIEW");
  }
  if (delta !== null && delta < THUMBNAIL_CANDIDATE_REVIEW_GAP) {
    reasonCodes.push("RUNNER_UP_MARGIN_TOO_SMALL");
  }
  if (fullRightDelta !== null && fullRightDelta < FULL_RIGHT_REVIEW_GAP) {
    reasonCodes.push("FULL_RIGHT_MARGIN_TOO_SMALL");
  }
  if (!centerEligible) reasonCodes.push("CENTER_NOT_ELIGIBLE");
  const needsReview = reasonCodes.length > 0;
  return Object.freeze({
    classification: needsReview ? "B" : "A",
    confidence: needsReview ? "medium" : "high",
    risk: needsReview ? "review" : "safe",
    needs_review: needsReview,
    score_delta: delta,
    full_right_delta: fullRightDelta,
    reason_codes: reasonCodes,
  });
}
