import assert from "node:assert/strict";
import test from "node:test";
import { executeAffiliateLinkUpdates, normalizeAffiliateUrl, resolveAffiliateLinkImport } from "../importer/affiliate-link-importer.mjs";

const uuid = "123e4567-e89b-42d3-a456-426614174000";
const url = "https://link.affiliate.myfans.jp/observed-link";

test("strict importer URL validation rejects spoof hosts, HTTP, credentials, and malformed values", () => {
  assert.equal(normalizeAffiliateUrl(url), url);
  for (const value of [
    "http://link.affiliate.myfans.jp/x",
    "https://user:pass@link.affiliate.myfans.jp/x",
    "https://link.affiliate.myfans.jp.evil.example/x",
    "not a url",
  ]) assert.equal(normalizeAffiliateUrl(value), null);
});

test("MISSING becomes ACTIVE_NEW, identical ACTIVE is no-op, and conflicting ACTIVE blocks", () => {
  const posts = [{ post_uuid: uuid, displayed_affiliate_url: url }];
  assert.equal(resolveAffiliateLinkImport(posts, [{ external_post_id: uuid, affiliate_link_status: "missing", affiliate_url: null }]).counts.ACTIVE_NEW, 1);
  assert.equal(resolveAffiliateLinkImport(posts, [{ external_post_id: uuid, affiliate_link_status: "active", affiliate_url: url }]).counts.ACTIVE_IDENTICAL, 1);
  const conflict = resolveAffiliateLinkImport(posts, [{ external_post_id: uuid, affiliate_link_status: "active", affiliate_url: `${url}-other` }]);
  assert.equal(conflict.counts.CONFLICT, 1);
  assert.equal(conflict.safe_to_apply, false);
});

test("invalid and missing DB identities fail closed with zero writes", () => {
  const result = resolveAffiliateLinkImport([
    { post_uuid: "bad", displayed_affiliate_url: url },
    { post_uuid: uuid, displayed_affiliate_url: url },
  ], []);
  assert.equal(result.counts.INVALID, 2);
  assert.equal(result.db_write_count, 0);
  assert.equal(result.safe_to_apply, false);
});

test("target-scoped transaction changes only MISSING affiliate columns and second run is idempotent", async () => {
  const rows = [{ external_post_id: uuid, affiliate_link_status: "missing", affiliate_url: null, title: "unchanged" }];
  const first = resolveAffiliateLinkImport([{ post_uuid: uuid, displayed_affiliate_url: url }], rows);
  const result = await executeAffiliateLinkUpdates(first, {
    transaction: async (callback) => callback({
      updateMissingAffiliateLink: async (target) => {
        const row = rows.find((item) => item.external_post_id === target.external_post_id);
        if (!row || row.affiliate_link_status !== target.expected_status || row.affiliate_url !== target.expected_url) return 0;
        assert.deepEqual(target.allowed_columns, ["affiliate_link_status", "affiliate_url"]);
        row.affiliate_link_status = target.next_status;
        row.affiliate_url = target.next_url;
        return 1;
      },
    }),
  });
  assert.deepEqual(result, { updated: 1, inserts: 0, deletes: 0, other_columns_changed: 0 });
  assert.equal(rows[0].title, "unchanged");
  const second = resolveAffiliateLinkImport([{ post_uuid: uuid, displayed_affiliate_url: url }], rows);
  assert.equal(second.counts.ACTIVE_IDENTICAL, 1);
  assert.equal(second.counts.ACTIVE_NEW, 0);
});

test("conflicts are rejected before the transaction starts", async () => {
  const resolution = resolveAffiliateLinkImport(
    [{ post_uuid: uuid, displayed_affiliate_url: url }],
    [{ external_post_id: uuid, affiliate_link_status: "active", affiliate_url: `${url}-other` }],
  );
  let transactions = 0;
  await assert.rejects(executeAffiliateLinkUpdates(resolution, {
    transaction: async () => { transactions += 1; },
  }), /RESOLUTION_BLOCKED/);
  assert.equal(transactions, 0);
});
