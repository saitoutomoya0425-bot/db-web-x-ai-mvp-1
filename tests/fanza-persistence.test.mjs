import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  FANZA_SOURCE_PRODUCT_CONFLICT_KEY,
  buildStagedFanzaSourceRows,
  persistStagedFanzaProducts,
} from "../src/lib/fanza/persistence.ts";

const fetchedAt = "2026-08-12T00:00:00.000Z";
const jobId = "10fcbdbe-110c-457b-9e92-dca5830a058f";
const normalized = {
  externalProductId: "fixture001",
  originalProductCode: "FIXTURE-001",
  productCode: "FIXTURE001",
  normalizedProductCode: "FIXTURE001",
  productCodeRejectionCode: null,
  title: "fixture",
  actressNames: ["fixture actress"],
  makerName: "fixture maker",
  seriesName: null,
  labelName: null,
  genres: [],
  releaseDate: "2026-08-12",
  description: null,
  thumbnailUrl: "https://pics.dmm.co.jp/fixture.jpg",
  cardThumbnailUrl: "https://pics.dmm.co.jp/fixture.jpg",
  sampleImages: [],
  sampleVideoUrl: null,
  officialUrl: "https://video.dmm.co.jp/fixture001",
  affiliateUrl: "https://al.fanza.co.jp/fixture001",
};

function product(overrides = {}) {
  return {
    externalProductId: "fixture001",
    rawPayload: { content_id: "fixture001", nested: { stable: true } },
    payloadHash: "",
    normalized,
    previewStatus: "new",
    duplicateVideoId: null,
    existingSourceProductId: null,
    existingReviewStatus: null,
    existingPreviewStatus: null,
    existingAttemptCount: 0,
    reviewReasons: [],
    ...overrides,
  };
}

function legacyRow(staged, importJobId) {
  const previewStatus = staged.existingPreviewStatus === "needs_review"
    || staged.existingPreviewStatus === "duplicate"
    ? staged.existingPreviewStatus
    : staged.previewStatus;
  return {
    data_source_id: "source-1",
    import_job_id: importJobId,
    external_product_id: staged.externalProductId,
    product_code: staged.normalized.productCode,
    original_product_code: staged.normalized.originalProductCode,
    normalized_product_code: staged.normalized.normalizedProductCode,
    raw_payload: staged.rawPayload,
    normalized_data: staged.normalized,
    payload_hash: staged.payloadHash || createHash("sha256").update(JSON.stringify(staged.rawPayload)).digest("hex"),
    fetched_at: fetchedAt,
    preview_status: previewStatus,
    review_status: staged.existingReviewStatus ?? "pending",
    duplicate_video_id: staged.duplicateVideoId,
    error_message: staged.reviewReasons.length ? staged.reviewReasons.join(",") : null,
    attempt_count: Math.max(0, staged.existingAttemptCount ?? 0) + 1,
    last_attempt_at: fetchedAt,
    next_retry_at: null,
  };
}

test("new persistence rows are byte-for-byte equivalent to the previous save contract", () => {
  const staged = product();
  const [actual] = buildStagedFanzaSourceRows({
    dataSourceId: "source-1", importJobId: jobId, products: [staged], fetchedAt,
  });
  assert.deepEqual(actual, legacyRow(staged, jobId));
});

test("source state, reasons, duplicate linkage and attempts remain unchanged", () => {
  for (const scenario of [
    product({ previewStatus: "new" }),
    product({ previewStatus: "needs_review", reviewReasons: ["actress_metadata_missing"] }),
    product({ previewStatus: "duplicate", duplicateVideoId: "video-1" }),
    product({ previewStatus: "unchanged", existingReviewStatus: "promoted", existingPreviewStatus: "needs_review", existingAttemptCount: 4 }),
  ]) {
    const [actual] = buildStagedFanzaSourceRows({
      dataSourceId: "source-1", importJobId: jobId, products: [scenario], fetchedAt,
    });
    assert.deepEqual(actual, legacyRow(scenario, jobId));
  }
});

test("payload hash is stable and supplied hashes are preserved", () => {
  const raw = product();
  const supplied = product({ payloadHash: "a".repeat(64) });
  const rows = buildStagedFanzaSourceRows({
    dataSourceId: "source-1", importJobId: null, products: [raw, supplied], fetchedAt,
  });
  assert.equal(rows[0].payload_hash, createHash("sha256").update(JSON.stringify(raw.rawPayload)).digest("hex"));
  assert.equal(rows[1].payload_hash, supplied.payloadHash);
});

test("supplied and null import job provenance are represented exactly", () => {
  const withJob = buildStagedFanzaSourceRows({
    dataSourceId: "source-1", importJobId: jobId, products: [product()], fetchedAt,
  });
  const withoutJob = buildStagedFanzaSourceRows({
    dataSourceId: "source-1", importJobId: null, products: [product()], fetchedAt,
  });
  assert.equal(withJob[0].import_job_id, jobId);
  assert.equal(withoutJob[0].import_job_id, null);
});

test("persistence uses one existing upsert contract and returns the saved count", async () => {
  const calls = [];
  const admin = {
    from(table) {
      assert.equal(table, "source_products");
      return {
        async upsert(rows, options) {
          calls.push({ rows, options });
          return { error: null };
        },
      };
    },
  };
  const result = await persistStagedFanzaProducts({
    admin, dataSourceId: "source-1", importJobId: jobId, products: [product()], fetchedAt,
  });
  assert.equal(result.saved, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options, { onConflict: FANZA_SOURCE_PRODUCT_CONFLICT_KEY });
  assert.deepEqual(calls[0].rows, result.rows);
});

test("frozen resume is default-dry-run and contains no FANZA fetch path", async () => {
  const source = await readFile(new URL("../scripts/fanza-resume-frozen-candidates.mjs", import.meta.url), "utf8");
  assert.match(source, /const write = options\.get\("write"\) === true/);
  assert.doesNotMatch(source, /api\.dmm\.com|fetchFanzaProducts|FANZA_API_ID|FANZA_AFFILIATE_ID/);
  assert.match(source, /fanza_api_calls: 0/);
});
