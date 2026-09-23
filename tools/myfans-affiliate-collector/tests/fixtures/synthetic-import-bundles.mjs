const COLLECTED_AT = "2026-09-23T15:59:52.088Z";

function syntheticUuid(index) {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

export function syntheticImportPost(index = 0, overrides = {}) {
  const uuid = syntheticUuid(index);
  const page = Math.floor(index / 20) + 1;
  return {
    post_uuid: uuid,
    post_public_url: `https://myfans.jp/posts/${uuid}`,
    title: `Synthetic visible post title ${index + 1}`,
    creator_name: `Synthetic Creator ${index % 10}`,
    creator_username: `synthetic_creator_${index % 10}`,
    creator_profile_url: null,
    price_jpy: 1000 + index,
    affiliate_reward_rate: 50,
    estimated_reward_jpy: 400,
    media_type: "video",
    video_duration: "12:34",
    video_duration_seconds: 754,
    likes: null,
    relative_published_text: "3日前",
    affiliate_eligible: true,
    source_surface: "post_search",
    source_page_url: `https://www.affiliate.myfans.jp/affiliates/search?page=${page}`,
    collected_at: COLLECTED_AT,
    parser_confidence: "HIGH",
    ...overrides
  };
}

export function syntheticImportBundle(posts, overrides = {}) {
  const pageCount = overrides.pageCount ?? Math.max(1, Math.ceil(posts.length / 20));
  const creators = overrides.creators ?? [];
  const pages = Array.from({ length: pageCount }, (_, index) => ({
    source_surface: "post_search",
    source_page_url: `https://www.affiliate.myfans.jp/affiliates/search?page=${index + 1}`,
    collected_at: COLLECTED_AT,
    fingerprint: `synthetic-page-${index + 1}`,
    detected_posts: Math.min(20, Math.max(0, posts.length - index * 20)),
    detected_creators: 0,
    warnings: []
  }));
  const bundle = {
    schema_version: "myfans-affiliate-catalog-local-v1",
    collector_version: "0.1.8",
    source: {
      system: "MyFans Affiliate Center",
      mode: "RENDERED_UI_TEXT",
      host: "www.affiliate.myfans.jp"
    },
    collected_at: COLLECTED_AT,
    stop_reason: pageCount >= 5 ? "MAX_PAGE_LIMIT_REACHED" : "NEXT_CONTROL_ABSENT_OR_DISABLED",
    pages,
    creators,
    posts,
    counts: {
      pages_scanned: pages.length,
      creators: creators.length,
      posts: posts.length,
      duplicate_creators_skipped: 0,
      duplicate_posts_skipped: 0,
      warnings: 0
    },
    warnings: []
  };
  const { pageCount: _pageCount, creators: _creators, ...bundleOverrides } = overrides;
  return { ...bundle, ...bundleOverrides };
}

export function syntheticHundredPostBundle() {
  return syntheticImportBundle(
    Array.from({ length: 100 }, (_, index) => syntheticImportPost(index)),
    { pageCount: 5 }
  );
}
