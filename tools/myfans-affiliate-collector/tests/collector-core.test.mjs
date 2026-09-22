import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import {
  snapshot,
  syntheticCreatorDescriptor,
  syntheticPostDescriptor,
  syntheticPostTitleCases
} from "./fixtures/synthetic-page-models.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(testDir, "..");
const coreSource = await readFile(path.join(extensionRoot, "src/collector-core.js"), "utf8");
const sandbox = { URL, console, setTimeout, clearTimeout };
vm.createContext(sandbox);
vm.runInContext(coreSource, sandbox, { filename: "collector-core.js" });
const core = sandbox.MyFansCollectorCore;

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function fakeClock() {
  let current = 0;
  return {
    now: () => current,
    sleep: async (milliseconds) => {
      current += milliseconds;
    },
    elapsed: () => current
  };
}

test("reports collector version 0.1.3", () => {
  assert.equal(core.COLLECTOR_VERSION, "0.1.3");
});

test("strictly accepts a public MyFans post UUID URL", () => {
  assert.deepEqual(plain(core.parsePostUrl(syntheticPostDescriptor.post_href)), {
    post_uuid: "123e4567-e89b-12d3-a456-426614174000",
    post_public_url: "https://myfans.jp/posts/123e4567-e89b-12d3-a456-426614174000"
  });
  assert.equal(core.parsePostUrl("https://myfans.jp/posts/not-a-uuid"), null);
  assert.equal(core.parsePostUrl("http://myfans.jp/posts/123e4567-e89b-12d3-a456-426614174000"), null);
  assert.equal(core.parsePostUrl("https://example.test/posts/123e4567-e89b-12d3-a456-426614174000"), null);
  assert.equal(core.parsePostUrl("https://myfans.jp/posts/123e4567-e89b-12d3-a456-426614174000/extra"), null);
});

test("accepts only an already displayed link.affiliate URL, never an API host", () => {
  assert.equal(
    core.parseDisplayedAffiliateUrl("https://link.affiliate.myfans.jp/synthetic-visible-link"),
    "https://link.affiliate.myfans.jp/synthetic-visible-link"
  );
  assert.equal(core.parseDisplayedAffiliateUrl("https://api.affiliate.myfans.jp/api/links"), null);
  assert.equal(core.parseDisplayedAffiliateUrl("https://www.affiliate.myfans.jp/affiliates/generated"), null);
});

test("uses a visible Affiliate Center creator route for identity without inventing a public profile URL", () => {
  const record = plain(
    core.extractCreatorFromDescriptor({
      profile_href: "https://www.affiliate.myfans.jp/affiliates/search/creators/route_only_creator",
      affiliate_creator_href: "https://www.affiliate.myfans.jp/affiliates/search/creators/route_only_creator",
      text: "Route Only Creator フォロワー 10",
      name_candidates: ["Route Only Creator"],
      links: [],
      source_surface: "creator_list",
      source_page_url: "https://www.affiliate.myfans.jp/affiliates/search/creators",
      collected_at: "2026-09-22T00:00:00.000Z"
    })
  );
  assert.equal(record.username, "route_only_creator");
  assert.equal(record.profile_url, null);
  assert.equal(
    core.parseAffiliateCreatorRoute("https://www.affiliate.myfans.jp/affiliates/search/creators/tab/registered"),
    null
  );
});

test("extracts the synthetic post title, creator, prices, rate, duration, likes, and relative time", () => {
  const record = plain(core.extractPostFromDescriptor(syntheticPostDescriptor));
  assert.equal(record.title, "Synthetic Post Title");
  assert.equal(record.creator_name, "Synthetic Creator");
  assert.equal(record.creator_username, "synthetic_creator");
  assert.equal(record.creator_profile_url, "https://myfans.jp/synthetic_creator");
  assert.equal(record.price_jpy, 5980);
  assert.equal(record.affiliate_reward_rate, 50);
  assert.equal(record.estimated_reward_jpy, 2511);
  assert.equal(record.media_type, "video");
  assert.equal(record.video_duration, "12:34");
  assert.equal(record.video_duration_seconds, 754);
  assert.equal(record.likes, 321);
  assert.equal(record.relative_published_text, "3日前");
  assert.equal(record.affiliate_eligible, true);
  assert.equal(record.displayed_affiliate_url, "https://link.affiliate.myfans.jp/synthetic-visible-link");
  assert.equal(record.parser_confidence, "HIGH");
});

test("removes only a trailing relative time from creator_name", () => {
  assert.equal(core.cleanCreatorName("烈 5か月前"), "烈");
  assert.equal(
    core.cleanCreatorName("P活専門動画 サマースカイ（2日に1回投稿中） 3か月前"),
    "P活専門動画 サマースカイ（2日に1回投稿中）"
  );
  assert.equal(core.cleanCreatorName("Creator 2026"), "Creator 2026");
  assert.equal(core.cleanCreatorName("昨日も投稿する人"), "昨日も投稿する人");

  for (const example of [
    { raw: "烈 5か月前", expected: "烈" },
    {
      raw: "P活専門動画 サマースカイ（2日に1回投稿中） 3か月前",
      expected: "P活専門動画 サマースカイ（2日に1回投稿中）"
    }
  ]) {
    const record = plain(
      core.extractPostFromDescriptor({
        ...syntheticPostDescriptor,
        creator_name_candidates: [example.raw]
      })
    );
    assert.equal(record.creator_name, example.expected);
  }
});

test("extracts a title from semantic nearby text while excluding creator, date, price, and actions", () => {
  const record = plain(core.extractPostFromDescriptor(syntheticPostDescriptor));
  assert.equal(record.title, "Synthetic Post Title");
  assert.notEqual(record.title, "Synthetic Creator");
  assert.notEqual(record.title, "3日前");
  assert.notEqual(record.title, "単品販売価格 5,980円");

  const metadataOnly = plain(
    core.extractPostFromDescriptor({
      ...syntheticPostDescriptor,
      title_candidates: [
        "Synthetic Creator",
        "3日前",
        "単品販売価格 5,980円",
        "アフィ報酬率:50%（¥2,511）",
        "プロフィールURL",
        "投稿のアフィURLのコピー"
      ]
    })
  );
  assert.equal(metadataOnly.title, null);
});

test("rejects profile affiliate actions and never falls back to creator name", () => {
  const actionOnly = plain(
    core.extractPostFromDescriptor({
      ...syntheticPostDescriptor,
      title_candidates: [
        "プロフィールのアフィURLのコピー",
        "投稿のアフィURLのコピー",
        "Synthetic Creator",
        "@synthetic_creator"
      ]
    })
  );
  assert.equal(actionOnly.title, null);
  assert.equal(actionOnly.creator_name, "Synthetic Creator");
  assert.equal(actionOnly.parser_confidence, "MEDIUM");
});

test("keeps a real long post text after rejecting surrounding metadata", () => {
  const longTitle = "A deliberately long synthetic post text ".repeat(12).trim();
  assert.ok(longTitle.length > 300);
  const record = plain(
    core.extractPostFromDescriptor({
      ...syntheticPostDescriptor,
      title_candidates: [
        "Synthetic Creator 3か月前",
        "プロフィールのアフィURLのコピー",
        "12:34",
        longTitle
      ]
    })
  );
  assert.equal(record.title, longTitle);
});

test("extracts normal, multiline, ellipsis, and nearby synthetic titles without guessing", () => {
  for (const titleCase of syntheticPostTitleCases) {
    const record = plain(
      core.extractPostFromDescriptor({
        ...syntheticPostDescriptor,
        anchor_text: titleCase.anchor_text ?? syntheticPostDescriptor.anchor_text,
        title_candidates: titleCase.title_candidates
      })
    );
    assert.equal(record.title, titleCase.expected, titleCase.name);
  }
});

test("does not interpret a reward amount as likes without explicit like semantics", () => {
  const rewardOnly = plain(
    core.extractPostFromDescriptor({
      ...syntheticPostDescriptor,
      text: "Synthetic Post Title Synthetic Creator いいね アフィ報酬率:50%（¥1,592）",
      likes_candidates: ["いいね"]
    })
  );
  assert.equal(rewardOnly.estimated_reward_jpy, 1592);
  assert.equal(rewardOnly.likes, null);

  const explicitHeart = plain(
    core.extractPostFromDescriptor({
      ...syntheticPostDescriptor,
      text: "Synthetic Post Title Synthetic Creator アフィ報酬率:50%（¥1,592）",
      likes_candidates: ["heart 27"]
    })
  );
  assert.equal(explicitHeart.estimated_reward_jpy, 1592);
  assert.equal(explicitHeart.likes, 27);
  assert.equal(core.parseLikes(["いいねする 31"]), 31);
});

test("parses reward percentage and parenthesized yen amount independently", () => {
  for (const example of [
    { text: "アフィ報酬率:50%（¥2,511）", rate: 50, amount: 2511 },
    { text: "アフィ報酬率:100%（¥4,980）", rate: 100, amount: 4980 },
    { text: "アフィ報酬率:25% (￥1,245)", rate: 25, amount: 1245 }
  ]) {
    const record = plain(
      core.extractPostFromDescriptor({
        ...syntheticPostDescriptor,
        text: `Synthetic Post Title Synthetic Creator 単品販売価格 5,980円 ${example.text}`
      })
    );
    assert.equal(record.affiliate_reward_rate, example.rate);
    assert.equal(record.estimated_reward_jpy, example.amount);
  }

  const missingAmount = plain(
    core.extractPostFromDescriptor({
      ...syntheticPostDescriptor,
      text: "Synthetic Post Title Synthetic Creator 単品販売価格 5,980円 アフィ報酬率:50%"
    })
  );
  assert.equal(missingAmount.affiliate_reward_rate, 50);
  assert.equal(missingAmount.estimated_reward_jpy, null);
});

test("extracts synthetic creator stats, rates, public SNS URL, and plan fields", () => {
  const record = plain(core.extractCreatorFromDescriptor(syntheticCreatorDescriptor));
  assert.equal(record.creator_name, "Synthetic Creator");
  assert.equal(record.username, "synthetic_creator");
  assert.equal(record.likes, 4210);
  assert.equal(record.followers, 2345);
  assert.equal(record.following, 12);
  assert.equal(record.post_count, 91);
  assert.equal(record.affiliate_enabled_post_count, 37);
  assert.equal(record.single_reward_rate, 20);
  assert.equal(record.plan_initial_reward_rate, 30);
  assert.equal(record.plan_continuation_reward_rate, 8);
  assert.deepEqual(record.social_profile_urls, ["https://x.com/synthetic_creator"]);
  assert.deepEqual(record.plans, [
    {
      plan_name: "Synthetic Plan",
      monthly_price_jpy: 1500,
      plan_post_count: 18,
      plan_description: "Synthetic plan description"
    }
  ]);
});

test("deduplicates posts by UUID and creators by username", () => {
  const post = plain(core.extractPostFromDescriptor(syntheticPostDescriptor));
  const creator = plain(core.extractCreatorFromDescriptor(syntheticCreatorDescriptor));
  const bundle = plain(
    core.buildExport([
      snapshot({ posts: [post], creators: [creator] }),
      snapshot({
        source_page_url: "https://www.affiliate.myfans.jp/affiliates/search?page=2",
        posts: [post],
        creators: [{ ...creator, creator_name: "Duplicate display" }]
      })
    ])
  );
  assert.equal(bundle.posts.length, 1);
  assert.equal(bundle.creators.length, 1);
  assert.equal(bundle.counts.duplicate_posts_skipped, 1);
  assert.equal(bundle.counts.duplicate_creators_skipped, 1);
});

test("stops pagination when the next control is absent", async () => {
  let activations = 0;
  const bundle = plain(
    await core.runPagination({
      max_pages: 5,
      collect_current: async () => snapshot(),
      get_next_control: async () => null,
      activate_next: async () => {
        activations += 1;
      },
      wait_for_page_change: async () => true,
      collected_at: "2026-09-22T00:00:00.000Z"
    })
  );
  assert.equal(bundle.counts.pages_scanned, 1);
  assert.equal(bundle.stop_reason, "NEXT_CONTROL_ABSENT_OR_DISABLED");
  assert.equal(activations, 0);
});

test("waits through a URL-first transition until the post UUID fingerprint changes", async () => {
  const firstPost = plain(core.extractPostFromDescriptor(syntheticPostDescriptor));
  const secondPost = { ...firstPost, post_uuid: "223e4567-e89b-12d3-a456-426614174001" };
  const previous = snapshot({ posts: [firstPost] });
  previous.fingerprint = core.fingerprintPage(previous);
  const staleAfterUrlChange = snapshot({
    source_page_url: "https://www.affiliate.myfans.jp/affiliates/search?page=2",
    posts: [firstPost]
  });
  const ready = snapshot({
    source_page_url: "https://www.affiliate.myfans.jp/affiliates/search?page=2",
    posts: [secondPost]
  });
  const candidates = [staleAfterUrlChange, staleAfterUrlChange, ready];
  let polls = 0;
  const clock = fakeClock();
  const transition = plain(
    await core.waitForDistinctPage({
      previous_fingerprint: previous.fingerprint,
      previous_url: previous.source_page_url,
      previous_snapshot: previous,
      collect_current: async () => {
        polls += 1;
        return candidates.shift() || ready;
      },
      timeout_ms: 1000,
      poll_interval_ms: 250,
      now: clock.now,
      sleep: clock.sleep
    })
  );
  assert.equal(transition.status, "READY");
  assert.equal(transition.snapshot.posts[0].post_uuid, secondPost.post_uuid);
  assert.equal(polls, 3);
  assert.equal(clock.elapsed(), 500);
});

test("fails closed only after a true duplicate page remains until timeout", async () => {
  const firstPost = plain(core.extractPostFromDescriptor(syntheticPostDescriptor));
  const previous = snapshot({ posts: [firstPost] });
  previous.fingerprint = core.fingerprintPage(previous);
  const duplicate = snapshot({
    source_page_url: "https://www.affiliate.myfans.jp/affiliates/search?page=2",
    posts: [firstPost]
  });
  const clock = fakeClock();
  const transition = plain(
    await core.waitForDistinctPage({
      previous_fingerprint: previous.fingerprint,
      previous_url: previous.source_page_url,
      previous_snapshot: previous,
      collect_current: async () => duplicate,
      timeout_ms: 1000,
      poll_interval_ms: 250,
      now: clock.now,
      sleep: clock.sleep
    })
  );
  assert.equal(transition.status, "TIMEOUT");
  assert.equal(transition.reason, "DUPLICATE_PAGE_FINGERPRINT");
  assert.equal(clock.elapsed(), 1000);

  const bundle = plain(
    await core.runPagination({
      max_pages: 5,
      collect_current: async () => previous,
      get_next_control: async () => ({ label: "次へ" }),
      activate_next: async () => {},
      wait_for_page_change: async () => transition,
      collected_at: "2026-09-22T00:00:00.000Z"
    })
  );
  assert.equal(bundle.stop_reason, "DUPLICATE_PAGE_FINGERPRINT");
  assert.equal(bundle.counts.pages_scanned, 1);
  assert.equal(bundle.warnings.includes("DUPLICATE_PAGE_FINGERPRINT"), true);
});

test("counts only unique successful pages after a delayed transition", async () => {
  const firstPost = plain(core.extractPostFromDescriptor(syntheticPostDescriptor));
  const secondPost = { ...firstPost, post_uuid: "323e4567-e89b-12d3-a456-426614174002" };
  const first = snapshot({ posts: [firstPost] });
  const second = snapshot({
    source_page_url: "https://www.affiliate.myfans.jp/affiliates/search?page=2",
    posts: [secondPost]
  });
  let collects = 0;
  let nextChecks = 0;
  const bundle = plain(
    await core.runPagination({
      max_pages: 5,
      collect_current: async () => {
        collects += 1;
        return first;
      },
      get_next_control: async () => {
        nextChecks += 1;
        return nextChecks === 1 ? { label: "次へ" } : null;
      },
      activate_next: async () => {},
      wait_for_page_change: async () => ({ status: "READY", reason: null, snapshot: second }),
      collected_at: "2026-09-22T00:00:00.000Z"
    })
  );
  assert.equal(bundle.counts.pages_scanned, 2);
  assert.equal(bundle.counts.posts, 2);
  assert.equal(bundle.counts.duplicate_posts_skipped, 0);
  assert.equal(bundle.stop_reason, "NEXT_CONTROL_ABSENT_OR_DISABLED");
  assert.equal(collects, 1);
});

test("enforces the five-page pilot limit", async () => {
  let page = 1;
  const makePage = (pageNumber) => snapshot({
    source_page_url: `https://www.affiliate.myfans.jp/affiliates/search?page=${pageNumber}`,
    posts: [{ post_uuid: `00000000-0000-0000-0000-${String(pageNumber).padStart(12, "0")}` }]
  });
  const bundle = plain(
    await core.runPagination({
      max_pages: 99,
      collect_current: async () => makePage(page),
      get_next_control: async () => ({ label: "次へ" }),
      activate_next: async () => {},
      wait_for_page_change: async () => {
        page += 1;
        return { status: "READY", reason: null, snapshot: makePage(page) };
      }
    })
  );
  assert.equal(bundle.counts.pages_scanned, 5);
  assert.equal(bundle.stop_reason, "MAX_PAGE_LIMIT_REACHED");
});

test("stops on login redirects, anti-bot/rate-limit text, and unexpected modals", () => {
  assert.equal(
    core.detectStopCondition({ url: "https://www.affiliate.myfans.jp/signin", visible_text: "", has_login_form: true }),
    "LOGIN_REDIRECT"
  );
  assert.equal(
    core.detectStopCondition({
      url: "https://www.affiliate.myfans.jp/affiliates/search",
      visible_text: "Too Many Requests"
    }),
    "RATE_LIMIT_OR_ANTI_BOT"
  );
  assert.equal(
    core.detectStopCondition({
      url: "https://www.affiliate.myfans.jp/affiliates/search",
      visible_text: "",
      has_unexpected_modal: true
    }),
    "UNEXPECTED_MODAL"
  );
});

test("probe output redacts arbitrary labels and exposes only URL patterns", () => {
  const probe = plain(
    core.makeProbeSummary({
      source_page_url: "https://www.affiliate.myfans.jp/affiliates/search",
      collected_at: "2026-09-22T00:00:00.000Z",
      elements: [
        {
          tag: "A",
          aria_label: "Actual Creator Name",
          href: syntheticPostDescriptor.post_href,
          button_label: "Actual Post Title",
          hierarchy: [{ tag: "ARTICLE", role: "listitem" }]
        },
        { tag: "BUTTON", button_label: "次へ", hierarchy: [] }
      ],
      card_field_presence: { price_label: true, reward_rate_label: true }
    })
  );
  assert.equal(probe.elements[0].aria_label, "REDACTED");
  assert.equal(probe.elements[0].button_label, "REDACTED");
  assert.equal(probe.elements[0].href_pattern, "MYFANS_POST_UUID");
  assert.equal(probe.elements[1].button_label, "次へ");
  assert.equal(probe.field_presence.price_label, true);
  assert.equal(probe.field_presence.reward_rate_label, true);
  assert.equal(JSON.stringify(probe).includes("Actual Creator Name"), false);
  assert.equal(JSON.stringify(probe).includes("Actual Post Title"), false);
});

test("rejects image and credential fields from any export depth", () => {
  assert.throws(() => core.assertSafeExport({ posts: [{ thumbnail_url: "https://cdn.example/x.jpg" }] }), /Forbidden/);
  assert.throws(() => core.assertSafeExport({ creators: [{ avatar_url: "https://cdn.example/a.jpg" }] }), /Forbidden/);
  assert.throws(() => core.assertSafeExport({ account: { email: "SYNTHETIC_REDACTED_EMAIL" } }), /Forbidden/);
  assert.throws(() => core.assertSafeExport({ auth: { token: "secret" } }), /Forbidden/);
  const bundle = core.buildExport([
    snapshot({
      posts: [plain(core.extractPostFromDescriptor(syntheticPostDescriptor))],
      creators: [plain(core.extractCreatorFromDescriptor(syntheticCreatorDescriptor))]
    })
  ]);
  assert.equal(core.assertSafeExport(bundle), true);
});

test("produces a design-only text staging plan with null image columns and no relative timestamp conversion", () => {
  const bundle = plain(
    core.buildExport([
      snapshot({
        posts: [plain(core.extractPostFromDescriptor(syntheticPostDescriptor))],
        creators: [plain(core.extractCreatorFromDescriptor(syntheticCreatorDescriptor))]
      })
    ])
  );
  const plan = plain(core.buildPrivateStagingPlan(bundle));
  assert.equal(plan.apply, false);
  assert.equal(plan.validation.valid, true);
  assert.equal(plan.targets.myfans_creators[0].profile_image_url, null);
  assert.equal(plan.targets.myfans_posts[0].thumbnail_url, null);
  assert.equal(plan.targets.myfans_posts[0].published_at, null);
  assert.equal(plan.targets.myfans_plans.length, 0);
  assert.equal(plan.unresolved_plan_candidates[0].import_status, "NEEDS_STABLE_PLAN_ID");
});
