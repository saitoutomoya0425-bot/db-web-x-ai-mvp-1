import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildFanzaFrontierAnchors,
  discoverAndCollectFanzaFrontier,
  fanzaFrontierMembershipSha256,
  fanzaFrontierPayloadMembershipSha256,
} from "../src/lib/fanza/frontier.ts";

const item = (id, payloadHash = `hash-${id}`) => ({ externalProductId: id, payloadHash, payload: { id } });
const parent = Array.from({ length: 1000 }, (_, index) => ({
  external_product_id: `old-${index + 1}`,
  normalized_product_code: `OLD${index + 1}`,
  release_date: "2026-08-11",
  payload_hash: `hash-old-${index + 1}`,
  source_offset: 1001 + index,
}));
const anchors = buildFanzaFrontierAnchors(parent, 25);
const parentIds = new Set(parent.map((record) => record.external_product_id));

function listingWithShift(shift = 250) {
  return [
    ...Array.from({ length: shift }, (_, index) => item(`insert-${index + 1}`)),
    ...Array.from({ length: 1000 }, (_, index) => item(`head-${index + 1}`)),
    ...parent.map((record) => item(record.external_product_id, record.payload_hash)),
    ...Array.from({ length: 1_200 }, (_, index) => item(`next-${index + 1}`)),
  ];
}

function fetcher(listing, requests = []) {
  return async (offset, pageSize) => {
    requests.push(offset);
    return listing.slice(offset - 1, offset - 1 + pageSize);
  };
}

const defaults = (listing, overrides = {}) => ({
  anchors,
  deepestAnchorExternalId: "old-1000",
  parentExternalIds: parentIds,
  searchStartOffset: 1801,
  pageSize: 100,
  maxAnchorPages: 25,
  minAnchorMatches: 5,
  windowSize: 1000,
  maxWindowPages: 15,
  fetchPage: fetcher(listing),
  ...overrides,
});

test("finds the deepest anchor after 250 live inserts without offset fallback", async () => {
  const requests = [];
  const result = await discoverAndCollectFanzaFrontier(defaults(listingWithShift(), {
    fetchPage: fetcher(listingWithShift(), requests),
  }));
  assert.equal(result.anchor.previousOffset, 2000);
  assert.equal(result.anchor.liveOffset, 2250);
  assert.equal(result.anchor.drift, 250);
  assert.equal(result.anchorMatches, 25);
  assert.equal(result.records.length, 1000);
  assert.equal(requests[0], 1801);
});

test("metadata updates reduce payload matches without breaking ID anchors", async () => {
  const listing = listingWithShift();
  for (const id of ["old-980", "old-990", "old-1000"]) {
    const match = listing.find((candidate) => candidate.externalProductId === id);
    match.payloadHash = `updated-${id}`;
  }
  const result = await discoverAndCollectFanzaFrontier(defaults(listing));
  assert.equal(result.anchorMatches, 25);
  assert.equal(result.anchorPayloadMatches, 22);
});

test("missing deepest anchor fails closed", async () => {
  const listing = listingWithShift().filter((candidate) => candidate.externalProductId !== "old-1000");
  await assert.rejects(discoverAndCollectFanzaFrontier(defaults(listing)), /PHASE5D_ANCHOR_NOT_FOUND/);
});

test("contradictory tail order is ambiguous", async () => {
  const listing = listingWithShift();
  const left = listing.findIndex((candidate) => candidate.externalProductId === "old-990");
  const right = listing.findIndex((candidate) => candidate.externalProductId === "old-991");
  [listing[left], listing[right]] = [listing[right], listing[left]];
  await assert.rejects(discoverAndCollectFanzaFrontier(defaults(listing)), /PHASE5D_ANCHOR_AMBIGUOUS/);
});

test("previous IDs after the anchor are skipped while 1000 unique records are collected", async () => {
  const listing = listingWithShift();
  listing.splice(2250, 0, item("old-500", "hash-old-500"));
  const result = await discoverAndCollectFanzaFrontier(defaults(listing));
  assert.equal(result.skippedPreviousIds, 1);
  assert.equal(result.records.length, 1000);
  assert.equal(result.records.some((candidate) => candidate.externalProductId === "old-500"), false);
  assert.equal(new Set(result.records.map((candidate) => candidate.externalProductId)).size, 1000);
});

test("membership hashes ignore timestamps but preserve order and payload identity", () => {
  const first = [
    { external_product_id: "a", payload_hash: "1", run_timestamp: "one" },
    { external_product_id: "b", payload_hash: "2", run_timestamp: "one" },
  ];
  const second = first.map((record) => ({ ...record, run_timestamp: "two" }));
  assert.equal(fanzaFrontierMembershipSha256(first), fanzaFrontierMembershipSha256(second));
  assert.equal(fanzaFrontierPayloadMembershipSha256(first), fanzaFrontierPayloadMembershipSha256(second));
  assert.notEqual(fanzaFrontierMembershipSha256(first), fanzaFrontierMembershipSha256([...first].reverse()));
});

test("offset freeze and no-fetch resume remain compatible", async () => {
  const freeze = await readFile(new URL("../scripts/fanza-freeze-window.mjs", import.meta.url), "utf8");
  const resume = await readFile(new URL("../scripts/fanza-resume-frozen-candidates.mjs", import.meta.url), "utf8");
  assert.match(freeze, /parseFanzaPaginationCli/);
  assert.match(freeze, /pagination\.startOffset/);
  assert.match(resume, /frozen\.map\(\(candidate\) => candidate\.raw_payload\)/);
  assert.doesNotMatch(resume, /api\.dmm\.com|fetchFanzaProducts|fetch\(/);
});
