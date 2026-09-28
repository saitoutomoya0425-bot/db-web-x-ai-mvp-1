import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { isMyFansPublicEnabled, loadMyFansPublicWhenEnabled } from "@/lib/myfans/public-feature";
import {
  isMyFansPublicPostId,
  toMyFansPublicWork,
  toMyFansPublicWorks,
  type MyFansPublicWork,
} from "@/lib/myfans/public-ui";
import type { MyFansApprovedPublicationProjection } from "@/types/database";

const PROJECTION = "myfans_approved_publication_projection" as const;
const MAX_PAGE_SIZE = 1000;

function cleanSearchQuery(value: string) {
  return value.replace(/[,%()]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

function pageSize(value: number | undefined, fallback: number) {
  return Math.min(Math.max(value ?? fallback, 1), MAX_PAGE_SIZE);
}

function requireValidProjectionRows(rows: readonly MyFansApprovedPublicationProjection[]) {
  const works = toMyFansPublicWorks(rows);
  if (works.length !== rows.length) throw new Error("MYFANS_PROJECTION_ROW_INVALID");
  return works;
}

export async function getMyFansPublicCatalogPage(options: { limit?: number; after?: string | null } = {}) {
  const enabled = isMyFansPublicEnabled();
  return loadMyFansPublicWhenEnabled(enabled, async () => {
    const limit = pageSize(options.limit, 100);
    let query = createAdminClient()
      .from(PROJECTION)
      .select("*")
      .order("external_post_id", { ascending: true });
    if (options.after) {
      if (!isMyFansPublicPostId(options.after)) throw new Error("INVALID_MYFANS_PUBLIC_CURSOR");
      query = query.gt("external_post_id", options.after.toLowerCase());
    }
    const { data, error } = await query.limit(limit);
    if (error) {
      console.error("MyFans approved catalog query failed");
      throw new Error("MYFANS_PUBLIC_CATALOG_QUERY_FAILED");
    }
    return requireValidProjectionRows(data ?? []);
  });
}

export async function searchMyFansPublicWorksPage(query: string, options: { limit?: number; after?: string | null } = {}) {
  const enabled = isMyFansPublicEnabled();
  const normalized = cleanSearchQuery(query);
  if (!normalized) return [];
  return loadMyFansPublicWhenEnabled(enabled, async () => {
    const limit = pageSize(options.limit, 24);
    let search = createAdminClient()
      .from(PROJECTION)
      .select("*")
      .or(`title.ilike.%${normalized}%,creator_display_name.ilike.%${normalized}%`)
      .order("external_post_id", { ascending: true });
    if (options.after) {
      if (!isMyFansPublicPostId(options.after)) throw new Error("INVALID_MYFANS_PUBLIC_CURSOR");
      search = search.gt("external_post_id", options.after.toLowerCase());
    }
    const { data, error } = await search.limit(limit);
    if (error) {
      console.error("MyFans approved search query failed");
      throw new Error("MYFANS_PUBLIC_SEARCH_QUERY_FAILED");
    }
    return requireValidProjectionRows(data ?? []);
  });
}

export async function getMyFansPublicWorkById(externalPostId: string): Promise<MyFansPublicWork | null> {
  if (!isMyFansPublicEnabled() || !isMyFansPublicPostId(externalPostId)) return null;
  const { data, error } = await createAdminClient()
    .from(PROJECTION)
    .select("*")
    .eq("external_post_id", externalPostId.toLowerCase())
    .maybeSingle();
  if (error || !data) {
    if (error) console.error("MyFans approved detail query failed");
    return null;
  }
  return toMyFansPublicWork(data);
}

export async function getMyFansPublicCount() {
  if (!isMyFansPublicEnabled()) return 0;
  const { count, error } = await createAdminClient()
    .from(PROJECTION)
    .select("external_post_id", { count: "exact", head: true });
  if (error) throw new Error("MYFANS_PUBLIC_COUNT_QUERY_FAILED");
  return count ?? 0;
}

export async function getMyFansPublicSitemapPage(page: number, limit: number) {
  if (!isMyFansPublicEnabled()) return [];
  if (!Number.isSafeInteger(page) || page < 0) throw new Error("INVALID_MYFANS_SITEMAP_PAGE");
  const boundedLimit = pageSize(limit, MAX_PAGE_SIZE);
  const start = page * boundedLimit;
  const { data, error } = await createAdminClient()
    .from(PROJECTION)
    .select("*")
    .order("external_post_id", { ascending: true })
    .range(start, start + boundedLimit - 1);
  if (error) throw new Error("MYFANS_PUBLIC_SITEMAP_QUERY_FAILED");
  return requireValidProjectionRows(data ?? []);
}
