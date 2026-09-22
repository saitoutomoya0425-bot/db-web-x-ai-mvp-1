export const syntheticPostDescriptor = Object.freeze({
  post_href: "https://myfans.jp/posts/123e4567-e89b-12d3-a456-426614174000",
  anchor_text: "",
  text: [
    "動画",
    "12:34",
    "Synthetic Post Title",
    "Synthetic Creator",
    "@synthetic_creator",
    "単品販売価格 5,980円",
    "アフィ報酬率:50%（¥2,511）",
    "いいね 321",
    "3日前"
  ].join(" "),
  title_candidates: [
    "12:34",
    "Synthetic Creator",
    "3日前",
    "単品販売価格 5,980円",
    "アフィ報酬率:50%（¥2,511）",
    "プロフィールURL",
    "プロフィールのアフィURLのコピー",
    "投稿のアフィURLのコピー",
    "Synthetic Post Title"
  ],
  creator_name_candidates: ["Synthetic Creator 3か月前"],
  likes_candidates: ["いいね 321"],
  links: [
    { href: "https://myfans.jp/synthetic_creator", text: "Synthetic Creator", visible: true },
    { href: "https://link.affiliate.myfans.jp/synthetic-visible-link", text: "表示済みURL", visible: true }
  ],
  source_surface: "post_search",
  source_page_url: "https://www.affiliate.myfans.jp/affiliates/search?media_type=video",
  collected_at: "2026-09-22T00:00:00.000Z"
});

export const syntheticPostTitleCases = Object.freeze([
  {
    name: "normal title",
    title_candidates: ["Synthetic normal post title"],
    expected: "Synthetic normal post title"
  },
  {
    name: "multiline title",
    title_candidates: ["Synthetic first line\nSynthetic second line"],
    expected: "Synthetic first line Synthetic second line"
  },
  {
    name: "ellipsis title",
    title_candidates: ["Synthetic title continues…"],
    expected: "Synthetic title continues…"
  },
  {
    name: "title outside the post anchor",
    anchor_text: "",
    title_candidates: ["投稿のアフィURLのコピー", "Synthetic sibling title"],
    expected: "Synthetic sibling title"
  },
  {
    name: "creator and date beside the title",
    title_candidates: ["Synthetic Creator", "3日前", "Synthetic nearby title"],
    expected: "Synthetic nearby title"
  },
  {
    name: "no title",
    title_candidates: [
      "Synthetic Creator",
      "@synthetic_creator",
      "3日前",
      "12:34",
      "321",
      "単品販売価格 5,980円",
      "アフィ報酬率:50%（¥2,511）",
      "プロフィールURL",
      "投稿のアフィURLのコピー"
    ],
    expected: null
  }
]);

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
