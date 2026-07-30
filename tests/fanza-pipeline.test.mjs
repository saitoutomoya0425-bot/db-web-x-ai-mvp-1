import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  fanzaSafetyReviewReasons,
  stageFanzaItems,
  runFanzaBatch,
} from "../src/lib/fanza/pipeline.ts";
import {
  buildItemErrorRecord,
  nextErrorAttempt,
  nextSourceState,
  safeImportErrorMessage,
} from "../src/lib/fanza/import-state.ts";

const fixture = JSON.parse(await readFile(new URL("./fixtures/fanza-itemlist-v3.json", import.meta.url), "utf8"));
const items = fixture.result.items;

function lookup(existing = []) {
  return {
    async byExternalIds(ids) {
      return new Map(ids.map((id) => [id, existing.filter((item) => item.externalProductId === id)]));
    },
    async byNormalizedCodes(codes) {
      return new Map(codes.map((code) => [code, existing.filter((item) => item.normalizedProductCode === code)]));
    },
  };
}

test("stages new, duplicate/update and review candidates without publishing", async () => {
  const result = await stageFanzaItems(items, lookup([
    {
      id: "video-1",
      externalProductId: "mock001",
      normalizedProductCode: "ABC001",
      title: "架空作品アルファ",
      actressNames: ["架空女優A"],
      makerName: "架空メーカーA",
      seriesName: "架空シリーズA",
      genres: ["架空ドラマ", "架空企画"],
    },
  ]));
  assert.equal(result.processed, 5);
  assert.equal(result.staged, 4);
  assert.equal(result.counts.new, 2);
  assert.equal(result.counts.needs_review, 2);
  assert.equal(result.products[0].normalized.sampleImages.length, 1);
  assert.equal(result.products[1].normalized.thumbnailUrl, null);
  assert.ok(result.products.every((item) => item.payloadHash.length === 64));
});

test("ambiguous external id and normalized product code matches are never auto-linked", async () => {
  const result = await stageFanzaItems([items[0]], lookup([
    { id: "external-match", kind: "video", externalProductId: "mock001", normalizedProductCode: "OTHER001" },
    { id: "code-match", kind: "video", externalProductId: "other", normalizedProductCode: "ABC001" },
  ]));
  assert.equal(result.counts.needs_review, 1);
  assert.equal(result.products[0].duplicateVideoId, null);
});

test("promoted, approved, rejected and needs-review state is preserved on refetch", () => {
  for (const reviewStatus of ["promoted", "approved", "rejected"]) {
    const state = nextSourceState({
      externalProductId: "mock001",
      rawPayload: {},
      payloadHash: "hash",
      normalized: {},
      previewStatus: "update",
      duplicateVideoId: "video-1",
      existingSourceProductId: "source-1",
      existingReviewStatus: reviewStatus,
      existingPreviewStatus: "needs_review",
      existingAttemptCount: 4,
    });
    assert.equal(state.reviewStatus, reviewStatus);
    assert.equal(state.previewStatus, "needs_review");
    assert.equal(state.attemptCount, 5);
  }
});

test("same batch normalized-code collision with different external ids needs review", async () => {
  const result = await stageFanzaItems([
    { content_id: "one", product_id: "ABC-999", title: "架空1" },
    { content_id: "two", product_id: "abc999", title: "架空2" },
  ], lookup());
  assert.equal(result.staged, 2);
  assert.equal(result.counts.needs_review, 2);
  assert.ok(result.products.every((product) => product.duplicateVideoId === null));
});

test("identical external id repeated in one batch stages only one source product", async () => {
  const raw = {
    content_id: "same-id",
    product_id: "SAME-001",
    title: "同一候補",
    URL: "https://video.dmm.co.jp/item/same-id",
    iteminfo: { actress: [{ name: "架空女優" }] },
  };
  const result = await stageFanzaItems([raw, structuredClone(raw)], lookup());
  assert.equal(result.processed, 2);
  assert.equal(result.staged, 1);
  assert.equal(result.counts.new, 1);
});

test("unpromoted source product code collision needs review", async () => {
  const result = await stageFanzaItems([
    { content_id: "new-external", product_id: "ABC-777", title: "新候補" },
  ], lookup([{
    id: "source-existing",
    kind: "source",
    externalProductId: "old-external",
    normalizedProductCode: "ABC777",
    reviewStatus: "pending",
    attemptCount: 1,
  }]));
  assert.equal(result.counts.needs_review, 1);
  assert.equal(result.products[0].duplicateVideoId, null);
});

test("same external source id updates one row and increments attempt", async () => {
  const result = await stageFanzaItems([items[0]], lookup([{
    id: "source-existing",
    kind: "source",
    externalProductId: "mock001",
    normalizedProductCode: "ABC001",
    title: "以前のタイトル",
    reviewStatus: "promoted",
    previewStatus: "update",
    attemptCount: 2,
    linkedVideoId: "video-1",
  }]));
  assert.equal(result.staged, 1);
  assert.equal(result.products[0].existingSourceProductId, "source-existing");
  const state = nextSourceState(result.products[0]);
  assert.equal(state.reviewStatus, "promoted");
  assert.equal(state.attemptCount, 3);
});

test("item error records contain safe retry metadata without secrets", () => {
  const record = buildItemErrorRecord({
    jobId: "job-1",
    apiOffset: 10,
    attemptCount: 2,
    error: {
      index: 3,
      externalProductId: "mock003",
      originalProductCode: "abc-003",
      stage: "normalize",
      errorType: "invalid_item",
      errorCode: "INVALID",
      message: "failed api_id=top-secret-value",
      rawPayload: { content_id: "mock003" },
      retryable: false,
    },
  });
  assert.equal(record.api_offset, 13);
  assert.equal(record.processing_stage, "normalize");
  assert.equal(record.attempt_count, 2);
  assert.equal(record.retryable, false);
  assert.doesNotMatch(record.message, /top-secret-value/);
  assert.equal(nextErrorAttempt(record.attempt_count), 3);
  assert.equal(safeImportErrorMessage("Bearer abcdef123456"), "Bearer [REDACTED]");
});

test("classification does not mutate existing public or private video records", async () => {
  const existingRows = [
    { id: "published", kind: "video", externalProductId: "mock001", normalizedProductCode: "ABC001", title: "公開作品", isPublished: true },
    { id: "private", kind: "video", externalProductId: "mock002", normalizedProductCode: "XYZ002", title: "非公開作品", isPublished: false },
  ];
  const before = structuredClone(existingRows);
  await stageFanzaItems(items.slice(0, 3), lookup(existingRows));
  assert.deepEqual(existingRows, before);
});

test("dry-run advances checkpoint but never persists", async () => {
  let persisted = 0;
  const output = await runFanzaBatch({
    checkpoint: { offset: 1, processed: 0, staged: 0, failed: 0, completed: false },
    batchSize: 2,
    maxItems: 2,
    dryRun: true,
    fetchPage: async () => ({ rawItems: items.slice(0, 2), hasMore: true }),
    lookup: lookup(),
    persist: async (products) => { persisted += products.length; },
  });
  assert.equal(persisted, 0);
  assert.equal(output.checkpoint.processed, 2);
  assert.equal(output.checkpoint.staged, 0);
  assert.equal(output.checkpoint.completed, true);
});

test("missing actress metadata is staged for manual review", async () => {
  const [raw] = fixture.result.items;
  const withoutActress = structuredClone(raw);
  delete withoutActress.iteminfo.actress;
  const result = await stageFanzaItems([withoutActress], lookup());
  assert.equal(result.counts.needs_review, 1);
  assert.equal(result.products[0].normalized.actressNames.length, 0);
  assert.equal(result.products[0].previewStatus, "needs_review");
  assert.deepEqual(result.products[0].reviewReasons, ["actress_metadata_missing"]);
});

test("safety gate rejects missing identifiers and non-official domains", () => {
  const reasons = fanzaSafetyReviewReasons({
    externalProductId: "",
    originalProductCode: null,
    productCode: null,
    normalizedProductCode: null,
    title: "候補",
    actressNames: ["架空女優"],
    makerName: "架空メーカー",
    seriesName: null,
    labelName: null,
    genres: [],
    releaseDate: null,
    description: null,
    thumbnailUrl: "https://invalid.example/image.jpg",
    sampleImages: [],
    sampleVideoUrl: null,
    officialUrl: "https://invalid.example/item",
    affiliateUrl: "https://invalid.example/affiliate",
    price: null,
    currency: "JPY",
    availabilityStatus: "available",
  });
  assert.deepEqual(reasons, [
    "external_product_id_missing",
    "product_code_missing",
    "normalized_product_code_missing",
    "official_url_not_allowed",
    "image_url_not_allowed",
    "affiliate_url_not_allowed",
  ]);
});

test("resume starts from saved offset and persists only the next batch", async () => {
  const offsets = [];
  let persisted = 0;
  const output = await runFanzaBatch({
    checkpoint: { offset: 3, processed: 2, staged: 2, failed: 0, completed: false },
    batchSize: 2,
    maxItems: 4,
    dryRun: false,
    fetchPage: async (offset) => {
      offsets.push(offset);
      return { rawItems: items.slice(2, 4), hasMore: true };
    },
    lookup: lookup(),
    persist: async (products) => { persisted += products.length; },
  });
  assert.deepEqual(offsets, [3]);
  assert.equal(persisted, 2);
  assert.equal(output.checkpoint.offset, 5);
  assert.equal(output.checkpoint.processed, 4);
  assert.equal(output.checkpoint.completed, true);
});

test("a failed page can be retried from the same checkpoint", async () => {
  const checkpoint = { offset: 1, processed: 0, staged: 0, failed: 0, completed: false };
  let attempts = 0;
  const options = {
    checkpoint,
    batchSize: 1,
    maxItems: 1,
    dryRun: false,
    fetchPage: async () => {
      attempts++;
      if (attempts === 1) throw new Error("temporary");
      return { rawItems: items.slice(0, 1), hasMore: false };
    },
    lookup: lookup(),
    persist: async () => {},
  };
  await assert.rejects(() => runFanzaBatch(options), /temporary/);
  const retried = await runFanzaBatch(options);
  assert.equal(retried.checkpoint.processed, 1);
  assert.equal(retried.checkpoint.completed, true);
});
