import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  priorityCandidateFromRaw,
  selectPriorityCandidates,
} from "../scripts/lib/fanza-priority.mjs";
import {
  buildPriorityFrozenArtifacts,
  buildPriorityFrozenRecords,
  buildPriorityFrozenSummary,
  priorityFrozenRecordsFromStaged,
} from "../scripts/lib/fanza-priority-provenance.mjs";
import {
  frozenSafeNewProvenanceIssues,
} from "../scripts/lib/fanza-frozen-provenance.mjs";
import { normalizeFanzaItem } from "../src/lib/fanza/normalize.ts";
import { buildStagedFanzaSourceRows } from "../src/lib/fanza/persistence.ts";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const asOf = "2026-08-29";
const runTimestamp = "2026-08-29T00:00:00.000Z";

function safeRaw(id, overrides = {}) {
  return {
    content_id: id,
    product_id: id.toUpperCase(),
    title: `title ${id}`,
    date: "2026-08-29 10:00:00",
    description: `description ${id}`,
    URL: `https://www.dmm.co.jp/digital/videoa/-/detail/=/cid=${id}/`,
    affiliateURL: `https://al.dmm.co.jp/?lurl=https%3A%2F%2Fwww.dmm.co.jp%2F${id}`,
    imageURL: { large: `https://pics.dmm.co.jp/digital/video/${id}/${id}pl.jpg` },
    iteminfo: {
      actress: [{ name: "actor" }],
      maker: [{ name: "maker" }],
      genre: [{ name: "genre" }],
    },
    ...overrides,
  };
}

function selected(raw, sort = "rank", position = 1) {
  const input = priorityCandidateFromRaw(raw, { asOf, sort, position });
  const selection = selectPriorityCandidates({
    rankCandidates: sort === "rank" ? [input] : [],
    latestCandidates: sort === "date" ? [input] : [],
    backfillCandidates: sort === "backfill" ? [input] : [],
    targetSize: 300,
  });
  return selection.candidates[0];
}

function lookup(rows = []) {
  return {
    async byExternalIds(ids) {
      return new Map(ids.map((id) => [id, rows.filter((row) => row.externalProductId === id)]));
    },
    async byNormalizedCodes(codes) {
      return new Map(codes.map((code) => [code, rows.filter((row) => row.normalizedProductCode === code)]));
    },
  };
}

test("lossless SAFE_NEW manifest round-trips through existing provenance and persistence contracts", async () => {
  const raw = safeRaw("safe001");
  const candidate = selected(raw);
  const { records, staged } = await buildPriorityFrozenRecords({
    candidates: [candidate], lookup: lookup(), runTimestamp,
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].classification, "SAFE_NEW");
  assert.equal(records[0].raw_payload, raw);
  assert.deepEqual(records[0].normalized, normalizeFanzaItem(raw));
  assert.equal(records[0].external_product_id, records[0].normalized.externalProductId);
  assert.equal(records[0].normalized_product_code, records[0].normalized.normalizedProductCode);
  assert.equal(records[0].payload_hash, sha256(JSON.stringify(raw)));
  assert.deepEqual(frozenSafeNewProvenanceIssues(records[0]), []);

  const artifacts = buildPriorityFrozenArtifacts(records);
  const repeated = buildPriorityFrozenArtifacts(records);
  assert.deepEqual(artifacts, repeated);
  assert.equal(gunzipSync(gzipSync(artifacts.jsonl)).toString("utf8"), artifacts.jsonl);
  assert.equal(sha256(artifacts.jsonl), artifacts.manifest_sha256);

  const summary = buildPriorityFrozenSummary({
    records,
    artifacts,
    policyVersion: "priority-v1",
    generatedAt: runTimestamp,
    validUntil: "2026-08-30T00:00:00.000Z",
    asOf,
    laneCounts: { RECENT_POPULAR: 1, LATEST: 0, BACKFILL: 0 },
    metadataGets: 0,
  });
  assert.equal(summary.status, "FROZEN");
  assert.equal(summary.classifications.SAFE_NEW, 1);
  assert.equal(summary.raw_payload_count, 1);
  assert.equal(summary.normalized_count, 1);
  assert.equal(summary.payload_hash_verified_count, 1);
  assert.equal(summary.database_business_mutation, 0);

  const rows = buildStagedFanzaSourceRows({
    dataSourceId: "00000000-0000-4000-8000-000000000001",
    importJobId: null,
    products: staged.products,
    fetchedAt: runTimestamp,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].external_product_id, "safe001");
  assert.equal(rows[0].raw_payload, raw);
  assert.equal(rows[0].payload_hash, records[0].payload_hash);
});

test("classification mapping stays in parity with hardened staging", async (t) => {
  await t.test("SAFE_NEW", async () => {
    const result = await buildPriorityFrozenRecords({ candidates: [selected(safeRaw("new001"))], lookup: lookup(), runTimestamp });
    assert.equal(result.records[0].classification, "SAFE_NEW");
  });
  await t.test("NEEDS_REVIEW", async () => {
    const raw = safeRaw("review001", { iteminfo: { actress: [], maker: [{ name: "maker" }] } });
    const result = await buildPriorityFrozenRecords({ candidates: [selected(raw)], lookup: lookup(), runTimestamp });
    assert.equal(result.records[0].classification, "NEEDS_REVIEW");
    assert.ok(result.records[0].reason_codes.includes("actress_metadata_missing"));
  });
  await t.test("EXISTING_UNCHANGED", async () => {
    const raw = safeRaw("existing001");
    const existing = {
      id: "source-1", kind: "source", externalProductId: "existing001",
      normalizedProductCode: "EXISTING001", title: "title existing001",
      actressNames: ["actor"], makerName: "maker", seriesName: null, genres: ["genre"],
    };
    const result = await buildPriorityFrozenRecords({ candidates: [selected(raw)], lookup: lookup([existing]), runTimestamp });
    assert.equal(result.records[0].classification, "EXISTING_UNCHANGED");
  });
  await t.test("EXISTING_UPDATE", async () => {
    const raw = safeRaw("update001");
    const existing = {
      id: "source-2", kind: "source", externalProductId: "update001",
      normalizedProductCode: "UPDATE001", title: "old title",
      actressNames: ["actor"], makerName: "maker", seriesName: null, genres: ["genre"],
    };
    const result = await buildPriorityFrozenRecords({ candidates: [selected(raw)], lookup: lookup([existing]), runTimestamp });
    assert.equal(result.records[0].classification, "EXISTING_UPDATE");
  });
  await t.test("DUPLICATE", async () => {
    const raw = safeRaw("duplicate001");
    const collision = {
      id: "source-3", kind: "source", externalProductId: "another-id",
      normalizedProductCode: "DUPLICATE001", title: "other",
      actressNames: ["actor"], makerName: "maker", seriesName: null, genres: ["genre"],
    };
    const result = await buildPriorityFrozenRecords({ candidates: [selected(raw)], lookup: lookup([collision]), runTimestamp });
    assert.equal(result.records[0].classification, "DUPLICATE");
  });
  await t.test("INVALID identity mismatch", async () => {
    const candidate = { ...selected(safeRaw("invalid001")), external_product_id: "wrong-id" };
    const result = await buildPriorityFrozenRecords({ candidates: [candidate], lookup: lookup(), runTimestamp });
    assert.equal(result.records[0].classification, "INVALID");
  });
  await t.test("ERROR", () => {
    const candidate = selected(safeRaw("error001"));
    const records = priorityFrozenRecordsFromStaged({
      candidates: [candidate], runTimestamp,
      staged: { products: [], errors: [{ index: 0, errorType: "invalid_item" }] },
    });
    assert.equal(records[0].classification, "ERROR");
  });
});

test("small frozen dry-run fixture preserves exact records, classifications and planned SAFE_NEW rows", async () => {
  const safe = selected(safeRaw("fixture-safe"), "rank", 2);
  const review = selected(safeRaw("fixture-review", {
    iteminfo: { actress: [], maker: [{ name: "maker" }] },
  }), "date", 4);
  const existingRaw = safeRaw("fixture-existing");
  const existing = selected(existingRaw, "backfill", 9002);
  const existingRow = {
    id: "source-fixture", kind: "source", externalProductId: "fixture-existing",
    normalizedProductCode: "FIXTUREEXISTING", title: "title fixture-existing",
    actressNames: ["actor"], makerName: "maker", seriesName: null, genres: ["genre"],
  };
  const candidates = [safe, review, existing];
  const { records, staged } = await buildPriorityFrozenRecords({
    candidates, lookup: lookup([existingRow]), runTimestamp,
  });

  assert.equal(records.length, 3);
  assert.deepEqual(records.map((record) => record.classification), [
    "SAFE_NEW", "NEEDS_REVIEW", "EXISTING_UNCHANGED",
  ]);
  records.forEach((record, index) => {
    assert.equal(record.raw_payload, candidates[index].raw_payload);
    assert.deepEqual(record.normalized, normalizeFanzaItem(candidates[index].raw_payload));
    assert.equal(record.payload_hash, sha256(JSON.stringify(record.raw_payload)));
  });

  const firstArtifacts = buildPriorityFrozenArtifacts(records);
  const secondArtifacts = buildPriorityFrozenArtifacts(records);
  assert.deepEqual(firstArtifacts, secondArtifacts);
  const safeRecords = records.filter((record) => record.classification === "SAFE_NEW");
  assert.equal(safeRecords.length, 1);
  assert.deepEqual(frozenSafeNewProvenanceIssues(safeRecords[0]), []);
  const safeIds = new Set(safeRecords.map((record) => record.external_product_id));
  const plannedRows = buildStagedFanzaSourceRows({
    dataSourceId: "00000000-0000-4000-8000-000000000001",
    importJobId: null,
    products: staged.products.filter((product) => safeIds.has(product.externalProductId)),
    fetchedAt: runTimestamp,
  });
  assert.equal(plannedRows.length, 1);
  assert.equal(plannedRows[0].external_product_id, "fixture-safe");
});

test("resume provenance validator rejects tampering and every hardened identity or safety mismatch", async () => {
  const { records } = await buildPriorityFrozenRecords({
    candidates: [selected(safeRaw("guard001"))], lookup: lookup(), runTimestamp,
  });
  const valid = records[0];
  assert.deepEqual(frozenSafeNewProvenanceIssues(valid), []);
  assert.ok(frozenSafeNewProvenanceIssues({ ...valid, raw_payload: { ...valid.raw_payload, title: "tampered" } })
    .some((issue) => issue.endsWith(":payload_hash")));
  assert.ok(frozenSafeNewProvenanceIssues({ ...valid, normalized: null })
    .some((issue) => issue.endsWith(":normalized")));
  assert.ok(frozenSafeNewProvenanceIssues({ ...valid, external_product_id: "wrong-id" })
    .some((issue) => issue.endsWith(":external_id")));
  assert.ok(frozenSafeNewProvenanceIssues({ ...valid, normalized_product_code: "WRONGCODE" })
    .some((issue) => issue.endsWith(":normalized_code")));
  assert.ok(frozenSafeNewProvenanceIssues({ ...valid, actress_metadata_present: false })
    .some((issue) => issue.endsWith(":actress")));
  assert.ok(frozenSafeNewProvenanceIssues({ ...valid, classification: "NEEDS_REVIEW" })
    .some((issue) => issue.endsWith(":classification")));
});

test("fixture contract performs no network or database mutation", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("NETWORK_FORBIDDEN"); };
  try {
    const result = await buildPriorityFrozenRecords({
      candidates: [selected(safeRaw("offline001"), "date")], lookup: lookup(), runTimestamp,
    });
    assert.equal(result.records[0].classification, "SAFE_NEW");
    assert.equal(result.records[0].raw_source_sort, "date");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
