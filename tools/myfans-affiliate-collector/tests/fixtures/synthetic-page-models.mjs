export const syntheticPostDescriptor = Object.freeze({
  post_href: "https://myfans.jp/posts/123e4567-e89b-12d3-a456-426614174000",
  anchor_text: "Synthetic Post Title",
  text: [
    "動画",
    "12:34",
    "Synthetic Post Title",
    "Synthetic Creator",
    "@synthetic_creator",
    "単品販売価格 1,980円",
    "アフィリエイト報酬率 12.5%",
    "推定報酬 247円",
    "いいね 321",
    "3日前"
  ].join(" "),
  title_candidates: ["Synthetic Post Title"],
  creator_name_candidates: ["Synthetic Creator"],
  links: [
    { href: "https://myfans.jp/synthetic_creator", text: "Synthetic Creator", visible: true },
    { href: "https://link.affiliate.myfans.jp/synthetic-visible-link", text: "表示済みURL", visible: true }
  ],
  source_surface: "post_search",
  source_page_url: "https://www.affiliate.myfans.jp/affiliates/search?media_type=video",
  collected_at: "2026-09-22T00:00:00.000Z"
});

export const syntheticCreatorDescriptor = Object.freeze({
  profile_href: "https://myfans.jp/synthetic_creator",
  text: [
    "Synthetic Creator",
    "@synthetic_creator",
    "投稿数 91",
    "いいね 4,210",
    "フォロワー 2,345",
    "フォロー 12",
    "アフィ設定作品の公開件数 37",
    "報酬単価（単品販売） 20%",
    "プラン加入報酬率 30%",
    "プラン継続報酬率 8%"
  ].join(" "),
  name_candidates: ["Synthetic Creator"],
  links: [
    { href: "https://myfans.jp/synthetic_creator", text: "Synthetic Creator", visible: true },
    { href: "https://x.com/synthetic_creator", text: "SNS", visible: true },
    { href: "https://cdn.example/avatar.png", text: "", visible: true }
  ],
  plan_candidates: [
    {
      text: "Synthetic Plan 月額 1,500円 プラン投稿数 18",
      title_candidates: ["Synthetic Plan"],
      description: "Synthetic plan description"
    }
  ],
  source_surface: "creator_detail",
  source_page_url: "https://www.affiliate.myfans.jp/affiliates/search/creators/synthetic_creator",
  collected_at: "2026-09-22T00:00:00.000Z"
});

export function snapshot(overrides = {}) {
  return {
    source_surface: "post_search",
    source_page_url: "https://www.affiliate.myfans.jp/affiliates/search?page=1",
    collected_at: "2026-09-22T00:00:00.000Z",
    posts: [],
    creators: [],
    warnings: [],
    stop_reason: null,
    ...overrides
  };
}
