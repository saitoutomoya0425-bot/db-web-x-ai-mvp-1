import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { isMyFansPublicEnabled, loadMyFansPublicWhenEnabled } from "@/lib/myfans/public-feature";
import {
  isMyFansPublicPostId,
  toMyFansPublicWork,
  toMyFansPublicWorks,
  type MyFansPublicWork,
} from "@/lib/myfans/public-ui";

const PROJECTION = "myfans_approved_publication_projection" as const;

function cleanSearchQuery(value: string) {
  return value.replace(/[,%()]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

export async function getMyFansPublicCatalog(options: { limit?: number; offset?: number } = {}) {
  const enabled = isMyFansPublicEnabled();
  return loadMyFansPublicWhenEnabled(enabled, async () => {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
    const offset = Math.max(options.offset ?? 0, 0);
    const { data, error } = await createAdminClient()
      .from(PROJECTION)
      .select("*")
      .order("external_post_id", { ascending: true })
      .range(offset, offset + limit - 1);
    if (error) {
      console.error("MyFans approved catalog query failed");
      return [];
    }
    return toMyFansPublicWorks(data ?? []);
  });
}

export async function searchMyFansPublicWorks(query: string, options: { limit?: number; offset?: number } = {}) {
  const enabled = isMyFansPublicEnabled();
  const normalized = cleanSearchQuery(query);
  if (!normalized) return [];
  return loadMyFansPublicWhenEnabled(enabled, async () => {
    const limit = Math.min(Math.max(options.limit ?? 24, 1), 100);
    const offset = Math.max(options.offset ?? 0, 0);
    const { data, error } = await createAdminClient()
      .from(PROJECTION)
      .select("*")
      .or(`title.ilike.%${normalized}%,creator_display_name.ilike.%${normalized}%`)
      .order("external_post_id", { ascending: true })
      .range(offset, offset + limit - 1);
    if (error) {
      console.error("MyFans approved search query failed");
      return [];
    }
    return toMyFansPublicWorks(data ?? []);
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

export async function getMyFansPublicSitemapWorks() {
  return getMyFansPublicCatalog({ limit: 1000, offset: 0 });
}
