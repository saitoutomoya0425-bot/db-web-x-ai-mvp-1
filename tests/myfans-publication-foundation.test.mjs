import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  MYFANS_AFFILIATE_LINK_STATUS,
  MYFANS_PUBLICATION_REVIEW_STATE,
  MYFANS_PUBLICATION_VISIBILITY,
  MYFANS_SOURCE_NAME,
  approvedMyFansPublicationProjection,
  decideMyFansPublication,
} from "../src/lib/myfans/publication.ts";
import {
  summarizeMyFansPrivatePreview,
  toMyFansPrivatePreview,
} from "../src/lib/myfans/private-preview.ts";

const id = "123e4567-e89b-12d3-a456-426614174000";
const approved = {
  sourceName: MYFANS_SOURCE_NAME,
  externalPostId: id,
  title: "表示済みの作品タイトル",
  canonicalUrl: `https://myfans.jp/posts/${id}`,
  creatorRelationValid: true,
  creatorPublicationVisibility: MYFANS_PUBLICATION_VISIBILITY.PUBLIC_GENERAL,
  creatorPublicationReviewState: MYFANS_PUBLICATION_REVIEW_STATE.APPROVED,
  postPublicationVisibility: MYFANS_PUBLICATION_VISIBILITY.AFFILIATE_VISIBLE,
  postPublicationReviewState: MYFANS_PUBLICATION_REVIEW_STATE.APPROVED,
  affiliateLinkStatus: MYFANS_AFFILIATE_LINK_STATUS.MISSING,
  affiliateUrl: null,
  prohibitedPrivateFields: [],
};

test("UNKNOWN creator visibility fails closed", () => {
  const result = decideMyFansPublication({
    ...approved,
    creatorPublicationVisibility: MYFANS_PUBLICATION_VISIBILITY.UNKNOWN,
  });
  assert.equal(result.eligible, false);
  assert.ok(result.blockReasons.includes("creator_visibility_not_approved"));
});

test("NEEDS_REVIEW creator fails closed", () => {
  const result = decideMyFansPublication({
    ...approved,
    creatorPublicationReviewState: MYFANS_PUBLICATION_REVIEW_STATE.NEEDS_REVIEW,
  });
  assert.equal(result.eligible, false);
  assert.ok(result.blockReasons.includes("creator_review_not_approved"));
});

test("approved creator with unapproved post remains blocked", () => {
  const result = decideMyFansPublication({
    ...approved,
    postPublicationReviewState: MYFANS_PUBLICATION_REVIEW_STATE.NEEDS_REVIEW,
  });
  assert.equal(result.eligible, false);
  assert.ok(result.blockReasons.includes("post_review_not_approved"));
});

test("approved creator and post are eligible without an image", () => {
  const result = decideMyFansPublication(approved);
  assert.equal(result.eligible, true);
  assert.equal(result.imageRequired, false);
  assert.equal(result.placeholder, "local_neutral");
});

test("MISSING affiliate link does not block publication and hides CTA", () => {
  const result = decideMyFansPublication(approved);
  assert.equal(result.eligible, true);
  assert.deepEqual(result.affiliateCta, {
    show: false,
    url: null,
    reason: "status_not_active",
  });
});

test("ACTIVE valid MyFans affiliate link shows CTA", () => {
  const affiliateUrl = `https://myfans.jp/posts/${id}?affiliate=synthetic`;
  const result = decideMyFansPublication({
    ...approved,
    affiliateLinkStatus: MYFANS_AFFILIATE_LINK_STATUS.ACTIVE,
    affiliateUrl,
  });
  assert.equal(result.eligible, true);
  assert.deepEqual(result.affiliateCta, {
    show: true,
    url: affiliateUrl,
    reason: "active_valid",
  });
});

test("REVOKED affiliate link hides CTA", () => {
  const result = decideMyFansPublication({
    ...approved,
    affiliateLinkStatus: MYFANS_AFFILIATE_LINK_STATUS.REVOKED,
    affiliateUrl: `https://myfans.jp/posts/${id}?affiliate=synthetic`,
  });
  assert.equal(result.eligible, true);
  assert.equal(result.affiliateCta.show, false);
  assert.equal(result.affiliateCta.url, null);
});

test("invalid canonical URL blocks publication", () => {
  const result = decideMyFansPublication({ ...approved, canonicalUrl: "https://example.test/post" });
  assert.equal(result.eligible, false);
  assert.ok(result.blockReasons.includes("canonical_url_invalid"));
});

test("private or prohibited fields block publication", () => {
  const result = decideMyFansPublication({
    ...approved,
    prohibitedPrivateFields: ["account_id"],
  });
  assert.equal(result.eligible, false);
  assert.ok(result.blockReasons.includes("prohibited_private_fields_present"));
});

test("approved-only in-memory projection excludes every unapproved row", () => {
  const unapproved = {
    ...approved,
    externalPostId: "123e4567-e89b-12d3-a456-426614174001",
    canonicalUrl: "https://myfans.jp/posts/123e4567-e89b-12d3-a456-426614174001",
    postPublicationReviewState: MYFANS_PUBLICATION_REVIEW_STATE.NEEDS_REVIEW,
  };
  assert.deepEqual(approvedMyFansPublicationProjection([approved, unapproved]), [approved]);
});

test("100 current fail-closed records project as zero eligible", () => {
  const current = Array.from({ length: 100 }, (_, index) => {
    const suffix = String(index).padStart(12, "0");
    const externalPostId = `123e4567-e89b-12d3-a456-${suffix}`;
    return {
      ...approved,
      externalPostId,
      canonicalUrl: `https://myfans.jp/posts/${externalPostId}`,
      creatorPublicationVisibility: MYFANS_PUBLICATION_VISIBILITY.UNKNOWN,
      creatorPublicationReviewState: MYFANS_PUBLICATION_REVIEW_STATE.NEEDS_REVIEW,
      postPublicationVisibility: MYFANS_PUBLICATION_VISIBILITY.UNKNOWN,
      postPublicationReviewState: MYFANS_PUBLICATION_REVIEW_STATE.NEEDS_REVIEW,
    };
  });
  assert.equal(approvedMyFansPublicationProjection(current).length, 0);
});

test("private preview is source-neutral, text-only, and reports its gate", () => {
  const item = toMyFansPrivatePreview({
    ...approved,
    creatorDisplayName: "Synthetic Creator",
    priceJpy: 1980,
    mediaType: "video",
  });
  assert.equal(item.sourceBadge, "MyFans");
  assert.deepEqual(item.placeholder, { kind: "local_neutral", label: "画像は掲載していません" });
  assert.equal(item.showAffiliateCta, false);
  assert.deepEqual(summarizeMyFansPrivatePreview([item]), {
    total: 1,
    eligible: 1,
    blocked: 0,
    affiliateCtaVisible: 0,
    neutralPlaceholders: 1,
  });
  assert.equal("thumbnailUrl" in item, false);
  assert.equal("rawPublicMetadata" in item, false);
});

test("migration is additive, fail-closed, and grants projection only to service_role", async () => {
  const sql = await readFile(new URL("../supabase/migrations/030_myfans_publication_foundation.sql", import.meta.url), "utf8");
  const compact = sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
  assert.doesNotMatch(compact, /\b(drop|truncate|insert|update|delete)\b/i);
  assert.match(compact, /publication_visibility text not null default 'unknown'/i);
  assert.match(compact, /publication_review_state text not null default 'needs_review'/i);
  assert.match(compact, /affiliate_link_status text not null default 'missing'/i);
  assert.match(compact, /security_invoker = true/i);
  assert.match(compact, /ds[.]is_active = true/i);
  assert.match(compact, /c[.]publication_review_state = 'approved'/i);
  assert.match(compact, /p[.]publication_review_state = 'approved'/i);
  assert.match(compact, /revoke all on public[.]myfans_approved_publication_projection from public, anon, authenticated/i);
  assert.match(compact, /grant select on public[.]myfans_approved_publication_projection to service_role/i);
  assert.doesNotMatch(compact, /grant [^;]+ to (?:public|anon|authenticated)/i);
});

test("private preview component is not reachable from an app route", async () => {
  const appRoot = new URL("../src/app/", import.meta.url);
  const pending = [appRoot];
  const sourceFiles = [];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
      if (entry.isDirectory()) pending.push(child);
      else if (/\.(?:ts|tsx)$/.test(entry.name)) sourceFiles.push(child);
    }
  }
  for (const sourceFile of sourceFiles) {
    const source = await readFile(sourceFile, "utf8");
    assert.doesNotMatch(source, /source-neutral-preview-card|myfans\/private-preview/i, path.basename(sourceFile.pathname));
  }
});
