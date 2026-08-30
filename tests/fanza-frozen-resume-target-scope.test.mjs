import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  assertDryRunTargetScopeUnchanged,
  assertWriteTargetScope,
  canonicalTargetScope,
  summarizeTargetScope,
} from "../scripts/lib/fanza-frozen-resume-target-scope.mjs";
import { fanzaSafetyReviewReasons } from "../src/lib/fanza/pipeline.ts";

const source = (overrides = {}) => ({
  id: "source-1",
  data_source_id: "fanza-source",
  external_product_id: "safe001",
  normalized_product_code: "SAFE001",
  payload_hash: "a".repeat(64),
  review_status: "pending",
  preview_status: "new",
  promoted_video_id: null,
  duplicate_video_id: null,
  import_job_id: null,
  attempt_count: 1,
  ...overrides,
});

const video = (overrides = {}) => ({
  id: "video-1",
  external_product_id: "existing001",
  product_code: "EXISTING001",
  ...overrides,
});

test("target evidence is stable, ordered and contains no global counts", () => {
  const first = { videos: [video({ id: "video-2" }), video()], sources: [source()] };
  const second = { videos: [...first.videos].reverse(), sources: [...first.sources] };
  assert.deepEqual(canonicalTargetScope(first), canonicalTargetScope(second));
  const summary = summarizeTargetScope(first);
  assert.deepEqual(Object.keys(summary), ["videos", "source_products", "evidence_sha256"]);
  assert.equal(summary.videos, 2);
  assert.equal(summary.source_products, 1);
  assert.match(summary.evidence_sha256, /^[0-9a-f]{64}$/);
});

test("dry-run requires exact target-scope equality", () => {
  const before = { videos: [video()], sources: [source()] };
  assert.doesNotThrow(() => assertDryRunTargetScopeUnchanged(before, structuredClone(before)));
  assert.throws(() => assertDryRunTargetScopeUnchanged(before, {
    videos: before.videos,
    sources: [source({ payload_hash: "b".repeat(64) })],
  }), /DRY_RUN_TARGET_SCOPE_CHANGED/);
});

test("write accepts only the exact planned target delta", () => {
  const before = { videos: [video()], sources: [source({
    id: "source-existing",
    external_product_id: "existing001",
    normalized_product_code: "EXISTING001",
  })] };
  const planned = {
    data_source_id: "fanza-source",
    external_product_id: "safe001",
    normalized_product_code: "SAFE001",
    payload_hash: "a".repeat(64),
  };
  const after = { videos: structuredClone(before.videos), sources: [
    structuredClone(before.sources[0]), source(),
  ] };
  assert.deepEqual(assertWriteTargetScope({
    before, after, plannedRows: [planned], importJobId: null,
  }), {
    exact_target_rows_added: 1,
    exact_target_rows_unchanged: 1,
    unexpected_target_mutation: 0,
  });
});

test("write rejects a preexisting planned target or any unrelated target mutation", () => {
  const planned = {
    data_source_id: "fanza-source",
    external_product_id: "safe001",
    normalized_product_code: "SAFE001",
    payload_hash: "a".repeat(64),
  };
  const existing = source();
  assert.throws(() => assertWriteTargetScope({
    before: { videos: [], sources: [existing] },
    after: { videos: [], sources: [existing] },
    plannedRows: [planned], importJobId: null,
  }), /TARGET_SOURCE_DELTA_MISMATCH/);

  const before = { videos: [], sources: [source({
    id: "source-existing", external_product_id: "existing001", normalized_product_code: "EXISTING001",
  })] };
  const after = { videos: [], sources: [
    source({ id: "source-existing", external_product_id: "existing001", normalized_product_code: "CHANGED" }),
    source(),
  ] };
  assert.throws(() => assertWriteTargetScope({
    before, after, plannedRows: [planned], importJobId: null,
  }), /UNEXPECTED_TARGET_SOURCE_MUTATION/);
});

test("resume source keeps safety and <=100 contracts while removing global scans", async () => {
  const resume = await readFile(new URL("../scripts/fanza-resume-frozen-candidates.mjs", import.meta.url), "utf8");
  assert.match(resume, /fanzaSafetyReviewReasons,[\s\S]*stageFanzaItems/);
  assert.match(resume, /fanzaSafetyReviewReasons\(product\.normalized\)\.length/);
  assert.match(resume, /expectedCount > 100/);
  assert.match(resume, /if \(write && plannedRows\.length\)/);
  assert.doesNotMatch(resume, /tableCount|async function snapshot|fanza_import_jobs|count:\s*"exact"/);
  assert.doesNotMatch(resume, /select\("\*"\)/);
  assert.match(resume, /\.in\("external_product_id", targetExternalIds\)/);
  assert.match(resume, /\.in\("normalized_product_code", normalizedCodes\)/);
  assert.match(resume, /global_full_count_recheck: "SKIPPED_BY_POLICY"/);
});

test("unsafe normalized metadata remains rejected by the imported safety gate", () => {
  const reasons = fanzaSafetyReviewReasons({
    externalProductId: "unsafe001",
    originalProductCode: "UNSAFE-001",
    productCode: "UNSAFE001",
    normalizedProductCode: "UNSAFE001",
    productCodeRejectionCode: null,
    title: "unsafe",
    actressNames: [],
    makerName: "maker",
    seriesName: null,
    labelName: null,
    genres: [],
    releaseDate: null,
    description: null,
    thumbnailUrl: null,
    cardThumbnailUrl: null,
    sampleImages: [],
    sampleVideoUrl: null,
    officialUrl: null,
    affiliateUrl: null,
  });
  assert.ok(reasons.length > 0);
  assert.ok(reasons.includes("actress_metadata_missing"));
});

test("171 targets are deterministically partitioned into 100 and 71 without overlap", () => {
  const targets = Array.from({ length: 171 }, (_, index) => `target-${index + 1}`);
  const chunks = [];
  for (let index = 0; index < targets.length; index += 100) chunks.push(targets.slice(index, index + 100));
  assert.deepEqual(chunks.map((chunk) => chunk.length), [100, 71]);
  assert.deepEqual(chunks.flat(), targets);
  assert.equal(new Set(chunks.flat()).size, 171);
});
