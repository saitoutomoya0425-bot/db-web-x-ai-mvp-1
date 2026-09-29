import { createHash } from "node:crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function normalizeAffiliateUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "link.affiliate.myfans.jp" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      url.hash ||
      ((!url.pathname || url.pathname === "/") && !url.search)
    ) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function resolveAffiliateLinkImport(posts, existingRows) {
  const existing = new Map((existingRows || []).map((row) => [String(row.external_post_id).toLowerCase(), row]));
  const seen = new Map();
  const items = [];
  for (const post of posts || []) {
    const postUuid = String(post?.post_uuid || "").toLowerCase();
    const affiliateUrl = normalizeAffiliateUrl(post?.displayed_affiliate_url);
    if (!UUID_RE.test(postUuid) || !affiliateUrl) {
      if (post?.displayed_affiliate_url) items.push({ post_uuid: postUuid || null, status: "INVALID" });
      continue;
    }
    const priorObserved = seen.get(postUuid);
    if (priorObserved && priorObserved !== affiliateUrl) {
      items.push({ post_uuid: postUuid, status: "CONFLICT" });
      continue;
    }
    seen.set(postUuid, affiliateUrl);
    const row = existing.get(postUuid);
    if (!row) {
      items.push({ post_uuid: postUuid, status: "INVALID", reason: "DB_POST_NOT_FOUND" });
      continue;
    }
    const currentStatus = String(row.affiliate_link_status || "missing").toLowerCase();
    const currentUrl = normalizeAffiliateUrl(row.affiliate_url);
    if (currentStatus === "active" && currentUrl === affiliateUrl) {
      items.push({ post_uuid: postUuid, status: "ACTIVE_IDENTICAL", affiliate_url: affiliateUrl });
    } else if (currentStatus === "missing" && !row.affiliate_url) {
      items.push({ post_uuid: postUuid, status: "ACTIVE_NEW", affiliate_url: affiliateUrl });
    } else {
      items.push({ post_uuid: postUuid, status: "CONFLICT", reason: "DB_AFFILIATE_STATE_CONFLICT" });
    }
  }
  const statuses = ["ACTIVE_NEW", "ACTIVE_IDENTICAL", "CONFLICT", "INVALID"];
  const counts = Object.fromEntries(statuses.map((status) => [status, items.filter((item) => item.status === status).length]));
  const targetIdentityHash = createHash("sha256")
    .update(items.filter((item) => item.status === "ACTIVE_NEW").map((item) => item.post_uuid).sort().join("\n"))
    .digest("hex");
  return {
    apply: false,
    db_write_count: 0,
    items,
    counts,
    target_identity_hash: targetIdentityHash,
    safe_to_apply: counts.CONFLICT === 0 && counts.INVALID === 0,
    mutation_contract: "myfans_posts affiliate_link_status/affiliate_url only; MISSING -> ACTIVE"
  };
}

export async function executeAffiliateLinkUpdates(resolution, adapter) {
  if (!resolution?.safe_to_apply) throw new Error("AFFILIATE_LINK_RESOLUTION_BLOCKED");
  if (typeof adapter?.transaction !== "function") throw new Error("AFFILIATE_DB_TRANSACTION_REQUIRED");
  const targets = resolution.items.filter((item) => item.status === "ACTIVE_NEW");
  return adapter.transaction(async (transaction) => {
    let updated = 0;
    for (const target of targets) {
      const count = await transaction.updateMissingAffiliateLink({
        external_post_id: target.post_uuid,
        expected_status: "missing",
        expected_url: null,
        next_status: "active",
        next_url: target.affiliate_url,
        allowed_columns: ["affiliate_link_status", "affiliate_url"],
      });
      if (count !== 1) throw new Error("AFFILIATE_LINK_TARGET_ROW_COUNT_MISMATCH");
      updated += count;
    }
    return { updated, inserts: 0, deletes: 0, other_columns_changed: 0 };
  });
}
