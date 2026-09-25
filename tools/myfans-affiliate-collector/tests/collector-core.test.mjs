import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import {
  snapshot,
  syntheticCreatorDescriptor,
  syntheticPostCardBoundaryCases,
  syntheticPostDescriptor,
  syntheticPostLeafTitleCases,
  syntheticPostSegmentTitleCases,
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

function missingTitleDescriptorWithDiagnostics(overrides = {}) {
  return {
    ...syntheticPostDescriptor,
    title_candidates: [
      "単品販売価格 5,980円",
      "アフィ報酬率:50%（¥2,511）",
      "Synthetic Creator",
      "3日前",
      "投稿のアフィURLのコピー"
    ],
    title_segment_candidates: [],
    title_leaf_candidates: [],
    title_diagnostic_context: {
      text_node_count: 7,
      anonymized_tag_sequence: ["article", "div", "span"],
      selected_container_depth: 1,
      selected_container_score: 92,
      post_link_count: 1,
      has_price_signal: true,
      has_reward_signal: true,
      has_affiliate_copy_action: true,
      has_creator_signal: true,
      ordered_segment_count: 7,
      ...overrides
    }
  };
}

function cumulativePost(index, page, overrides = {}) {
  const uuid = `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
  return {
    ...plain(core.extractPostFromDescriptor(syntheticPostDescriptor)),
    post_uuid: uuid,
    post_public_url: `https://myfans.jp/posts/${uuid}`,
    title: `Synthetic cumulative title ${index + 1}`,
    source_page_url: `https://www.affiliate.myfans.jp/affiliates/search?sexual_orientation=woman&page=${page}`,
    collected_at: `2026-09-${String(Math.min(30, page)).padStart(2, "0")}T00:00:00.000Z`,
    ...overrides
  };
}

function boundedRun({ startPage, pageCount = 5, posts, runId, stopReason = "MAX_PAGE_LIMIT_REACHED" }) {
  const perPage = Math.max(1, Math.ceil(posts.length / pageCount));
  const pages = Array.from({ length: pageCount }, (_, offset) => {
    const page = startPage + offset;
    return snapshot({
      source_page_url: `https://www.affiliate.myfans.jp/affiliates/search?sexual_orientation=woman&page=${page}`,
      collected_at: `2026-09-${String(Math.min(30, page)).padStart(2, "0")}T00:00:00.000Z`,
      posts: posts.slice(offset * perPage, (offset + 1) * perPage)
    });
  });
  const bundle = plain(core.buildExport(pages, {
    collected_at: pages.at(-1).collected_at,
    stop_reason: stopReason
  }));
  return plain(core.attachCollectionRunMetadata(bundle, {
    run_id: runId,
    mode: startPage === 1 ? "NEW" : "RESUME",
    expected_start_page: startPage,
    expected_scope_key: core.canonicalCollectionScope(pages[0].source_page_url).key,
    next_control: stopReason === "NEXT_CONTROL_ABSENT_OR_DISABLED"
      ? { present: false, enabled: false, href: null }
      : {
          present: true,
          enabled: true,
          href: `https://www.affiliate.myfans.jp/affiliates/search?sexual_orientation=woman&page=${startPage + pageCount}`
        }
  }));
}

function navigationSnapshot(page, overrides = {}) {
  const value = snapshot({
    source_page_url: `https://www.affiliate.myfans.jp/affiliates/search?sexual_orientation=woman&page=${page}`,
    collected_at: `2026-09-${String(Math.min(page, 30)).padStart(2, "0")}T00:00:00.000Z`,
    posts: [cumulativePost(500 + page, page)],
    ...overrides
  });
  value.fingerprint = core.fingerprintPage(value);
  return value;
}

function navigationHarness(options = {}) {
  let currentPage = options.startPage || 1;
  let closedPolls = 0;
  let stalePolls = 0;
  let navigationCount = 0;
  let commitCount = 0;
  const trace = [];
  const clock = fakeClock();
  const scope = core.collectionContextFromUrl(navigationSnapshot(currentPage).source_page_url).collection_scope;
  let previousBeforeNavigation = null;

  function currentSnapshot() {
    if (options.safetyStopPage === currentPage) {
      return navigationSnapshot(currentPage, {
        posts: [],
        stop_reason: options.safetyStopReason || "LOGIN_REDIRECT"
      });
    }
    if (stalePolls > 0 && previousBeforeNavigation) {
      stalePolls -= 1;
      return navigationSnapshot(currentPage, {
        posts: previousBeforeNavigation.posts
      });
    }
    return navigationSnapshot(currentPage);
  }

  const adapters = {
    collect_current: async () => currentSnapshot(),
    prepare_navigation: async (message) => {
      if (options.channelCloseBeforeAckAtPage === currentPage) {
        throw new Error("A listener indicated an asynchronous response, but the message channel closed before a response was received");
      }
      previousBeforeNavigation = message.previous_snapshot;
      const fromPage = currentPage;
      const nextPage = fromPage + 1;
      const ack = {
        ok: true,
        operation_id: message.operation_id,
        operation_stage: message.operation_stage,
        navigation_expected: options.endPage == null || fromPage < options.endPage,
        from_page: fromPage,
        expected_next_page: options.endPage != null && fromPage >= options.endPage ? null : nextPage,
        previous_fingerprint: message.previous_snapshot.fingerprint
      };
      trace.push(`ACK:${message.operation_stage}:${fromPage}`);
      if (ack.navigation_expected) {
        trace.push(`NAVIGATE:${fromPage}->${nextPage}`);
        currentPage = options.pageMismatchAtPage === fromPage ? nextPage + 1 : nextPage;
        navigationCount += 1;
        closedPolls = options.fullReloadClosedPolls || 0;
        stalePolls = options.staleDomPolls || 0;
      }
      return ack;
    },
    wait_for_ready: async ({ ack, previous_snapshot, ack_delivered }) => core.waitForNavigationReady({
      operation_id: ack.operation_id,
      ack,
      previous_snapshot,
      ack_delivered,
      expected_scope_key: scope.key,
      collect_current: async () => {
        if (closedPolls > 0) {
          closedPolls -= 1;
          throw new Error("A listener indicated an asynchronous response, but the message channel closed before a response was received");
        }
        return currentSnapshot();
      },
      timeout_ms: options.timeoutMs || 1000,
      poll_interval_ms: 250,
      now: clock.now,
      sleep: clock.sleep
    }),
    inspect_next: async () => ({
      present: options.endPage == null || currentPage < options.endPage,
      enabled: options.endPage == null || currentPage < options.endPage,
      href: options.endPage != null && currentPage >= options.endPage
        ? null
        : `https://www.affiliate.myfans.jp/affiliates/search?sexual_orientation=woman&page=${currentPage + 1}`
    }),
    commit_run: async (result) => {
      commitCount += 1;
      trace.push(`COMMIT:${result.pages_collected}`);
      return result;
    }
  };

  return {
    adapters,
    clock,
    scope,
    trace,
    get commitCount() {
      return commitCount;
    },
    get currentPage() {
      return currentPage;
    },
    get navigationCount() {
      return navigationCount;
    }
  };
}

test("reports collector version 0.3.2 and a five-page hard limit", () => {
  assert.equal(core.COLLECTOR_VERSION, "0.3.2");
  assert.equal(core.MAX_RUN_PAGES, 5);
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

test("scores every ancestor and selects the complete single-post card boundary", () => {
  for (const boundaryCase of syntheticPostCardBoundaryCases) {
    const selected = plain(core.selectPostCardContainerCandidate(boundaryCase.candidates));
    assert.equal(selected.id, boundaryCase.expected, boundaryCase.name);
  }
  const rowCase = syntheticPostCardBoundaryCases.find(
    (item) => item.name === "row containing two cards is ineligible"
  );
  const row = rowCase.candidates.find((candidate) => candidate.id === "two-card-row");
  assert.deepEqual(plain(core.scorePostCardContainerCandidate(row)), {
    eligible: false,
    score: -10000
  });
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

test("uses ordered visible leaf text only after semantic title candidates fail", () => {
  for (const titleCase of syntheticPostLeafTitleCases) {
    const record = plain(
      core.extractPostFromDescriptor({
        ...syntheticPostDescriptor,
        title_candidates: [],
        title_leaf_candidates: titleCase.leaves,
        title_diagnostic_context: {
          text_node_count: titleCase.leaves.length,
          anonymized_tag_sequence: ["article", "div", "span"]
        }
      })
    );
    assert.equal(record.title, titleCase.expected, titleCase.name);
    if (titleCase.expected) assert.equal("title_diagnostic" in record, false, titleCase.name);
  }
});

test("recovers only safe ordered segments between commerce and creator or action blocks", () => {
  for (const titleCase of syntheticPostSegmentTitleCases) {
    const record = plain(
      core.extractPostFromDescriptor({
        ...syntheticPostDescriptor,
        title_candidates: [],
        title_segment_candidates: titleCase.segments,
        title_leaf_candidates: [],
        title_diagnostic_context: {
          text_node_count: titleCase.segments.length,
          anonymized_tag_sequence: ["article", "div", "span"],
          selected_container_depth: 3,
          selected_container_score: 110,
          post_link_count: 1,
          has_price_signal: true,
          has_reward_signal: true,
          has_affiliate_copy_action: true,
          has_creator_signal: true,
          ordered_segment_count: titleCase.segments.length
        }
      })
    );
    assert.equal(record.title, titleCase.expected, titleCase.name);
    if (titleCase.expected) assert.equal("title_diagnostic" in record, false, titleCase.name);
    else assert.equal(record.title_diagnostic.segment_window_found, true, titleCase.name);
  }
});

test("accepts natural post titles that contain inline metadata tokens", () => {
  const acceptedTitles = [
    "期間限定で¥4,980にしました…",
    "右上のいいねとブックマークして感想を教えてください…",
    "彼氏が3日前にできたらしく、その話を詳しく聞きました…",
    "Synthetic Creatorにお願いして特別な動画を撮影しました…",
    "今日は最高だった♡",
    "❤たくさんありがとう、また感想を聞かせてください"
  ];

  for (const title of acceptedTitles) {
    const segments = [
      "アフィ報酬率50%",
      title,
      "Synthetic Creator",
      "3日前",
      "投稿のアフィURLのコピー"
    ].map((text, index) => ({
      text,
      strategy: "CARD_ORDERED_SEGMENT_WINDOW",
      segment_order: index + 1
    }));
    const record = plain(
      core.extractPostFromDescriptor({
        ...syntheticPostDescriptor,
        title_candidates: [],
        title_segment_candidates: segments,
        title_leaf_candidates: []
      })
    );
    assert.equal(record.title, title, title);
    assert.equal("title_diagnostic" in record, false, title);
  }
});

test("accepts safe long natural titles only inside the strong ordered title window", () => {
  const naturalSentence = "これは画面に表示された長い作品説明です。内容を正確に保存するための自然な文章が続きます。";
  const metadataSentence = "価格は¥4,980です。右上のいいねを押して、3日前の出来事について感想を教えてください。";
  const acceptedTitles = [
    naturalSentence.repeat(Math.ceil(1001 / naturalSentence.length)).slice(0, 1001),
    naturalSentence.repeat(Math.ceil(2000 / naturalSentence.length)).slice(0, 2000),
    metadataSentence.repeat(Math.ceil(1600 / metadataSentence.length)).slice(0, 1600)
  ];

  for (const title of acceptedTitles) {
    const segments = [
      "アフィ報酬率50%",
      title,
      "Synthetic Creator",
      "3日前",
      "投稿のアフィURLのコピー"
    ].map((text, index) => ({
      text,
      strategy: "CARD_ORDERED_SEGMENT_WINDOW",
      segment_order: index + 1
    }));
    const record = plain(
      core.extractPostFromDescriptor({
        ...syntheticPostDescriptor,
        title_candidates: [],
        title_segment_candidates: segments,
        title_leaf_candidates: []
      })
    );
    assert.equal(record.title, title, `accepted ${title.length} character title`);
    assert.equal("title_diagnostic" in record, false, `accepted ${title.length} character title`);
  }
});

test("rejects unsafe or misplaced long text and preserves the hard title cap", () => {
  const naturalSentence = "これは自然な長文ですが安全なタイトル位置にないため採用しません。";
  const outsideWindow = naturalSentence.repeat(Math.ceil(1200 / naturalSentence.length)).slice(0, 1200);
  const metadataOnly = "単品販売価格 ¥4,980 アフィ報酬率50% 3日前 いいね 123 ".repeat(40);
  const actionOnly = "投稿のアフィURLのコピー ".repeat(100);
  const overHardCap = naturalSentence
    .repeat(Math.ceil(10001 / naturalSentence.length))
    .slice(0, 10001);
  const rejectedCases = [
    {
      name: "long natural text outside the strong title window",
      segments: [outsideWindow, "Synthetic Creator", "3日前", "投稿のアフィURLのコピー"]
    },
    {
      name: "long natural text after price but without a reward block",
      segments: ["単品販売価格 ¥4,980", outsideWindow, "Synthetic Creator", "3日前", "投稿のアフィURLのコピー"]
    },
    {
      name: "long metadata-only text inside the title window",
      segments: ["アフィ報酬率50%", metadataOnly, "Synthetic Creator", "3日前", "投稿のアフィURLのコピー"]
    },
    {
      name: "long action-only text inside the title window",
      segments: ["アフィ報酬率50%", actionOnly, "Synthetic Creator", "3日前", "投稿のアフィURLのコピー"]
    },
    {
      name: "natural text above the hard title cap",
      segments: ["アフィ報酬率50%", overHardCap, "Synthetic Creator", "3日前", "投稿のアフィURLのコピー"]
    }
  ];

  for (const titleCase of rejectedCases) {
    const record = plain(
      core.extractPostFromDescriptor({
        ...syntheticPostDescriptor,
        title_candidates: [],
        title_segment_candidates: titleCase.segments.map((text, index) => ({
          text,
          strategy: "CARD_ORDERED_SEGMENT_WINDOW",
          segment_order: index + 1
        })),
        title_leaf_candidates: []
      })
    );
    assert.equal(record.title, null, titleCase.name);
    assert.equal(
      record.title_diagnostic.rejection_reason_codes.includes("TOO_LONG"),
      true,
      titleCase.name
    );
  }
});

test("continues to reject metadata-only ordered segments", () => {
  const rejectedTitles = [
    { text: "¥4,980", reason: "PRICE_OR_REWARD_AMOUNT" },
    { text: "単品販売価格 ¥4,980", reason: "PRICE" },
    { text: "アフィ報酬率50%", reason: "REWARD" },
    { text: "3日前", reason: "RELATIVE_DATE" },
    { text: "いいね 123", reason: "LIKES" },
    { text: "♡ 123", reason: "LIKES" },
    { text: "Synthetic Creator", reason: "CREATOR_OR_USERNAME" },
    { text: "@synthetic_creator", reason: "USERNAME" },
    { text: "プロフィールURL", reason: "AFFILIATE_OR_PROFILE_ACTION" },
    { text: "投稿のアフィURLのコピー", reason: "AFFILIATE_OR_PROFILE_ACTION" }
  ];

  for (const titleCase of rejectedTitles) {
    const segments = [
      "アフィ報酬率50%",
      titleCase.text,
      "Synthetic Creator",
      "3日前",
      "投稿のアフィURLのコピー"
    ].map((text, index) => ({
      text,
      strategy: "CARD_ORDERED_SEGMENT_WINDOW",
      segment_order: index + 1
    }));
    const record = plain(
      core.extractPostFromDescriptor({
        ...syntheticPostDescriptor,
        title_candidates: [],
        title_segment_candidates: segments,
        title_leaf_candidates: []
      })
    );
    assert.equal(record.title, null, titleCase.text);
    assert.equal(
      record.title_diagnostic.rejection_reason_codes.includes(titleCase.reason),
      true,
      titleCase.text
    );
  }
});

test("emits only sanitized reason codes and anonymous structure when title remains missing", () => {
  const titleCase = syntheticPostLeafTitleCases.find((item) => item.name === "truly missing title");
  const record = plain(
    core.extractPostFromDescriptor({
      ...syntheticPostDescriptor,
      title_candidates: [],
      title_leaf_candidates: titleCase.leaves,
      title_diagnostic_context: {
        text_node_count: titleCase.leaves.length,
        anonymized_tag_sequence: ["ARTICLE", "DIV", "SPAN", "x-private-card", "SCRIPT"],
        selected_container_depth: 4,
        selected_container_score: 108,
        post_link_count: 1,
        has_price_signal: true,
        has_reward_signal: true,
        has_affiliate_copy_action: true,
        has_creator_signal: true,
        ordered_segment_count: 9
      }
    })
  );
  assert.equal(record.title, null);
  assert.deepEqual(record.title_diagnostic, {
    post_uuid: record.post_uuid,
    text_node_count: titleCase.leaves.length,
    anonymized_dom_tag_sequence: ["article", "div", "span", "other", "other"],
    candidate_count: titleCase.leaves.length,
    rejection_reason_codes: [
      "MEDIA_BADGE",
      "DURATION",
      "PRICE",
      "REWARD",
      "NON_NATURAL_TEXT",
      "CREATOR_OR_USERNAME",
      "USERNAME",
      "RELATIVE_DATE",
      "AFFILIATE_OR_PROFILE_ACTION"
    ],
    chosen_strategy: "NONE",
    title_missing_reason: "NO_SAFE_NATURAL_TEXT_AFTER_METADATA_FILTER",
    selected_container_depth: 4,
    selected_container_score: 108,
    post_link_count: 1,
    has_price_signal: true,
    has_reward_signal: true,
    has_affiliate_copy_action: true,
    has_creator_signal: true,
    ordered_segment_count: 9,
    segment_window_found: false,
    missing_reason: "NO_SAFE_NATURAL_TEXT_AFTER_METADATA_FILTER"
  });
  const diagnosticText = JSON.stringify(record.title_diagnostic);
  for (const forbiddenValue of ["Synthetic Creator", "5,980", "2,511", "3日前", "x-private-card"]) {
    assert.equal(diagnosticText.includes(forbiddenValue), false);
  }
  assert.equal(core.assertSafeExport(record), true);
});

test("distinguishes no visible title candidates from candidates rejected as metadata", () => {
  const record = plain(
    core.extractPostFromDescriptor({
      ...syntheticPostDescriptor,
      title_candidates: [],
      title_leaf_candidates: [],
      title_diagnostic_context: {
        text_node_count: 0,
        anonymized_tag_sequence: ["article", "div"]
      }
    })
  );
  assert.equal(record.title, null);
  assert.equal(record.title_diagnostic.candidate_count, 0);
  assert.deepEqual(record.title_diagnostic.rejection_reason_codes, []);
  assert.equal(record.title_diagnostic.chosen_strategy, "NONE");
  assert.equal(record.title_diagnostic.title_missing_reason, "NO_VISIBLE_TITLE_CANDIDATES");
});

test("emits bounded ancestor and visible-segment diagnostics only for a missing title", () => {
  const longVisibleTitleCandidate = "Visible diagnostic title ".repeat(20).trim();
  const visibleSegments = [
    "Card preface",
    "単品販売価格 5,980円",
    "アフィ報酬率:50%（¥2,511）",
    longVisibleTitleCandidate,
    "Synthetic Creator",
    "3日前",
    "投稿のアフィURLのコピー",
    "After action note"
  ].map((text, index) => ({
    text,
    strategy: "CARD_ORDERED_SEGMENT_WINDOW",
    segment_order: index + 1
  }));
  const record = plain(
    core.extractPostFromDescriptor(
      missingTitleDescriptorWithDiagnostics({
        eligible_ancestors: [
          {
            depth: 1,
            score: 92,
            post_link_count: 1,
            safe_title_candidate_count: 0,
            ordered_segment_count: 8,
            has_price_signal: true,
            has_reward_signal: true,
            has_creator_signal: true,
            has_affiliate_copy_action: true
          },
          {
            depth: 2,
            score: 92,
            post_link_count: 1,
            safe_title_candidate_count: 0,
            ordered_segment_count: 10,
            has_price_signal: true,
            has_reward_signal: true,
            has_creator_signal: true,
            has_affiliate_copy_action: true
          }
        ],
        visible_segment_ancestors: [
          {
            depth: 1,
            selected: true,
            segments: visibleSegments,
            excluded_candidates: ["Synthetic Creator", "synthetic_creator", "@synthetic_creator"]
          },
          {
            depth: 2,
            selected: false,
            segments: visibleSegments,
            excluded_candidates: ["Synthetic Creator", "synthetic_creator", "@synthetic_creator"]
          }
        ]
      })
    )
  );

  assert.equal(record.title, null);
  assert.equal(record.title_diagnostic.eligible_ancestors.length, 2);
  assert.deepEqual(record.title_diagnostic.eligible_ancestors[0], {
    depth: 1,
    score: 92,
    post_link_count: 1,
    safe_title_candidate_count: 0,
    ordered_segment_count: 8,
    has_price_signal: true,
    has_reward_signal: true,
    has_creator_signal: true,
    has_affiliate_copy_action: true
  });
  assert.equal(record.title_diagnostic.visible_segment_ancestors.length, 2);
  const segments = record.title_diagnostic.visible_segment_ancestors[0].segments;
  assert.equal(segments[0].region, "BEFORE_PRICE");
  assert.equal(segments[1].region, "PRICE_REWARD");
  assert.equal(segments[2].region, "PRICE_REWARD");
  assert.equal(segments[3].region, "BETWEEN_REWARD_AND_CREATOR");
  assert.equal(segments[3].rejection_reason, null);
  assert.equal(segments[3].text.length, 300);
  assert.equal(segments[4].region, "CREATOR_DATE_ACTION");
  assert.equal(segments[6].region, "CREATOR_DATE_ACTION");
  assert.equal(segments[7].region, "AFTER_ACTION");
});

test("does not emit detailed missing-title diagnostics for a successful title", () => {
  const record = plain(
    core.extractPostFromDescriptor({
      ...syntheticPostDescriptor,
      title_candidates: ["A safe visible post title"],
      title_diagnostic_context: {
        eligible_ancestors: [{ depth: 1, score: 92, post_link_count: 1 }],
        visible_segment_ancestors: [{
          depth: 1,
          selected: true,
          segments: [{ text: "A safe visible post title", segment_order: 1 }],
          excluded_candidates: []
        }]
      }
    })
  );
  assert.equal(record.title, "A safe visible post title");
  assert.equal("title_diagnostic" in record, false);
});

test("caps missing-title segments and redacts markup, URLs, credentials, and account data", () => {
  const sensitiveSegments = [
    "<script>visible markup</script>",
    "https://cdn.example.test/private-image.jpg",
    "person@example.test",
    "token=synthetic-secret",
    "口座番号 1234567890",
    "X".repeat(500),
    ...Array.from({ length: 29 }, (_, index) => `Safe diagnostic line ${index + 1}`)
  ].map((text, index) => ({ text, segment_order: index + 1 }));
  const visibleSegmentAncestors = Array.from({ length: 4 }, (_, index) => ({
    depth: index + 1,
    selected: index === 0,
    segments: sensitiveSegments,
    excluded_candidates: []
  }));
  const record = plain(
    core.extractPostFromDescriptor(
      missingTitleDescriptorWithDiagnostics({ visible_segment_ancestors: visibleSegmentAncestors })
    )
  );
  const diagnostic = record.title_diagnostic;
  const serialized = JSON.stringify(diagnostic);

  assert.equal(diagnostic.visible_segment_ancestors.length, 3);
  assert.equal(diagnostic.visible_segment_ancestors[0].segments.length, 30);
  assert.equal(
    diagnostic.visible_segment_ancestors.every((ancestor) =>
      ancestor.segments.every((segment) => segment.text.length <= 300)
    ),
    true
  );
  for (const forbidden of [
    "<script>",
    "cdn.example.test",
    "private-image.jpg",
    "person@example.test",
    "synthetic-secret",
    "1234567890"
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.equal(serialized.includes("[MARKUP_REDACTED]"), true);
  assert.equal(serialized.includes("[URL_REDACTED]"), true);
  assert.equal(serialized.includes("[EMAIL_REDACTED]"), true);
  assert.equal(serialized.includes("[CREDENTIAL_REDACTED]"), true);
  assert.equal(serialized.includes("[ACCOUNT_DATA_REDACTED]"), true);
  assert.equal(core.assertSafeExport(record), true);
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

test("marks exactly five pages complete when the fifth page has no enabled next control", async () => {
  let page = 1;
  const makePage = (pageNumber) => snapshot({
    source_page_url: `https://www.affiliate.myfans.jp/affiliates/search?page=${pageNumber}`,
    posts: [{ post_uuid: `20000000-0000-4000-8000-${String(pageNumber).padStart(12, "0")}` }]
  });
  const bundle = plain(await core.runPagination({
    max_pages: 5,
    collect_current: async () => makePage(page),
    get_next_control: async () => page < 5 ? { label: "次へ" } : null,
    activate_next: async () => {},
    wait_for_page_change: async () => {
      page += 1;
      return { status: "READY", reason: null, snapshot: makePage(page) };
    }
  }));
  assert.equal(bundle.counts.pages_scanned, 5);
  assert.equal(bundle.stop_reason, "NEXT_CONTROL_ABSENT_OR_DISABLED");
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

test("canonicalizes collection scope without page and rejects cross-scope resume", () => {
  const first = plain(
    core.collectionContextFromUrl(
      "https://www.affiliate.myfans.jp/affiliates/search?sort=popular&page=6&sexual_orientation=woman"
    )
  );
  const same = plain(
    core.collectionContextFromUrl(
      "https://www.affiliate.myfans.jp/affiliates/search?sexual_orientation=woman&page=10&sort=popular"
    )
  );
  const other = plain(
    core.collectionContextFromUrl(
      "https://www.affiliate.myfans.jp/affiliates/search?sexual_orientation=man&page=6&sort=popular"
    )
  );
  assert.equal(first.collection_scope.key, same.collection_scope.key);
  assert.notEqual(first.collection_scope.key, other.collection_scope.key);
  assert.equal(first.page, 6);
  assert.equal(
    core.collectionContextFromUrl(
      "https://www.affiliate.myfans.jp/affiliates/search?sexual_orientation=woman&unknown_filter=value"
    ),
    null
  );

  const run = boundedRun({
    startPage: 1,
    posts: Array.from({ length: 5 }, (_, index) => cumulativePost(index, index + 1)),
    runId: "scope-run"
  });
  const merged = plain(core.mergeCumulativeCatalog(null, run));
  assert.throws(
    () => core.validateResumeCheckpoint(merged.catalog.checkpoint_summary, other.collection_scope),
    /CHECKPOINT_SCOPE_MISMATCH/
  );
});

test("checkpoints bounded runs at pages 1-5, resumes 6-10, then 11-15", () => {
  const firstPosts = Array.from({ length: 5 }, (_, index) => cumulativePost(index, index + 1));
  const secondPosts = Array.from({ length: 5 }, (_, index) => cumulativePost(index + 5, index + 6));
  const thirdPosts = Array.from({ length: 5 }, (_, index) => cumulativePost(index + 10, index + 11));
  const runOne = boundedRun({ startPage: 1, posts: firstPosts, runId: "run-1" });
  const first = plain(core.mergeCumulativeCatalog(null, runOne)).catalog;
  assert.equal(first.checkpoint_summary.start_page, 1);
  assert.equal(first.checkpoint_summary.collection_start_page, 1);
  assert.equal(first.checkpoint_summary.last_successfully_collected_page, 5);
  assert.equal(first.checkpoint_summary.next_page_candidate.page, 6);
  assert.equal(first.checkpoint_summary.pages_collected_this_run, 5);
  assert.equal(first.checkpoint_summary.cumulative_unique_post_count, 5);
  assert.equal(first.checkpoint_summary.completion_state, "IN_PROGRESS");

  const resumeOne = plain(
    core.validateResumeCheckpoint(first.checkpoint_summary, first.collection_scope)
  );
  assert.equal(resumeOne.page, 6);
  const runTwo = boundedRun({ startPage: 6, posts: secondPosts, runId: "run-2" });
  const second = plain(core.mergeCumulativeCatalog(first, runTwo)).catalog;
  assert.equal(second.checkpoint_summary.start_page, 6);
  assert.equal(second.checkpoint_summary.collection_start_page, 1);
  assert.equal(second.checkpoint_summary.last_successfully_collected_page, 10);
  assert.equal(second.checkpoint_summary.next_page_candidate.page, 11);
  assert.equal(second.counts.posts, 10);

  const runThree = boundedRun({
    startPage: 11,
    posts: thirdPosts,
    runId: "run-3",
    stopReason: "NEXT_CONTROL_ABSENT_OR_DISABLED"
  });
  const third = plain(core.mergeCumulativeCatalog(second, runThree)).catalog;
  assert.equal(third.checkpoint_summary.start_page, 11);
  assert.equal(third.checkpoint_summary.last_successfully_collected_page, 15);
  assert.equal(third.checkpoint_summary.completion_state, "COMPLETE");
  assert.equal(third.checkpoint_summary.next_page_candidate, null);
  assert.equal(third.counts.posts, 15);
});

test("falls back to the observed last page plus visible next control without guessing a URL", () => {
  const pages = Array.from({ length: 5 }, (_, offset) => snapshot({
    source_page_url: `https://www.affiliate.myfans.jp/affiliates/search?page=${offset + 1}`,
    posts: [cumulativePost(offset, offset + 1)]
  }));
  const bundle = core.buildExport(pages, { stop_reason: "MAX_PAGE_LIMIT_REACHED" });
  const run = plain(core.attachCollectionRunMetadata(bundle, {
    run_id: "button-only-next",
    mode: "NEW",
    next_control: { present: true, enabled: true, href: null }
  }));
  assert.deepEqual(run.collection_run.next_page_candidate, {
    mode: "VISIBLE_NEXT_FROM_LAST_PAGE",
    source_page_url: pages.at(-1).source_page_url,
    page: 5
  });
});

test("merges duplicates as no-op, allowed changes as updates, and conflicts fail closed", () => {
  const original = cumulativePost(0, 1);
  const firstRun = boundedRun({ startPage: 1, pageCount: 1, posts: [original], runId: "merge-1" });
  const first = plain(core.mergeCumulativeCatalog(null, firstRun)).catalog;

  const sameObservation = { ...original, collected_at: "2026-09-02T00:00:00.000Z" };
  const sameRun = boundedRun({ startPage: 1, pageCount: 1, posts: [sameObservation], runId: "merge-2" });
  const same = plain(core.mergeCumulativeCatalog(first, sameRun));
  assert.equal(same.merge.posts_unchanged, 1);
  assert.equal(same.catalog.counts.posts, 1);
  assert.equal(same.catalog.post_observations[0].first_seen_run, "merge-1");
  assert.equal(same.catalog.post_observations[0].last_seen_run, "merge-2");
  assert.equal(same.catalog.post_observations[0].first_seen_at, original.collected_at);
  assert.equal(same.catalog.post_observations[0].last_seen_at, sameObservation.collected_at);

  const changed = { ...original, title: "Updated allowed visible title" };
  const changedRun = boundedRun({ startPage: 1, pageCount: 1, posts: [changed], runId: "merge-3" });
  const updated = plain(core.mergeCumulativeCatalog(same.catalog, changedRun));
  assert.equal(updated.merge.posts_updated, 1);
  assert.equal(updated.catalog.posts[0].title, "Updated allowed visible title");

  const conflicting = {
    ...original,
    creator_username: "different_stable_creator",
    creator_profile_url: "https://myfans.jp/different_stable_creator"
  };
  const conflictRun = boundedRun({ startPage: 1, pageCount: 1, posts: [conflicting], runId: "merge-4" });
  assert.throws(
    () => core.mergeCumulativeCatalog(updated.catalog, conflictRun),
    /POST_CREATOR_IDENTITY_CONFLICT/
  );
  assert.equal(updated.catalog.posts[0].creator_username, original.creator_username);
});

test("preserves cumulative records and checkpoint after an interrupted run", () => {
  const initialPosts = [cumulativePost(0, 1), cumulativePost(1, 2)];
  const initialRun = boundedRun({ startPage: 1, pageCount: 2, posts: initialPosts, runId: "interrupt-1" });
  const initial = plain(core.mergeCumulativeCatalog(null, initialRun)).catalog;
  const interruptedBundle = core.buildExport([
    snapshot({
      source_page_url: "https://www.affiliate.myfans.jp/affiliates/search?sexual_orientation=woman&page=3",
      posts: [cumulativePost(2, 3)]
    })
  ], {
    stop_reason: "PAGE_TRANSITION_TIMEOUT",
    warnings: ["PAGE_TRANSITION_TIMEOUT"]
  });
  const interruptedRun = plain(core.attachCollectionRunMetadata(interruptedBundle, {
    run_id: "interrupt-2",
    mode: "RESUME",
    next_control: { present: false, enabled: false, href: null }
  }));
  const interrupted = plain(core.mergeCumulativeCatalog(initial, interruptedRun)).catalog;
  assert.equal(interrupted.counts.posts, 3);
  assert.equal(interrupted.checkpoint_summary.completion_state, "INTERRUPTED");
  assert.equal(interrupted.checkpoint_summary.stop_reason, "PAGE_TRANSITION_TIMEOUT");
  assert.equal(interrupted.checkpoint_summary.resume_supported, true);
});

test("cumulative absence never deletes records and 100 plus 80 yields 180 unique posts", () => {
  const firstHundred = Array.from({ length: 100 }, (_, index) => cumulativePost(index, Math.floor(index / 20) + 1));
  const nextHundred = [
    ...firstHundred.slice(80),
    ...Array.from({ length: 80 }, (_, index) => cumulativePost(index + 100, Math.floor(index / 20) + 6))
  ];
  const firstRun = boundedRun({ startPage: 1, posts: firstHundred, runId: "coverage-1" });
  const first = plain(core.mergeCumulativeCatalog(null, firstRun)).catalog;
  const secondRun = boundedRun({ startPage: 6, posts: nextHundred, runId: "coverage-2" });
  const second = plain(core.mergeCumulativeCatalog(first, secondRun));
  assert.equal(first.counts.posts, 100);
  assert.equal(second.catalog.counts.posts, 180);
  assert.equal(second.merge.posts_added, 80);
  assert.equal(second.merge.posts_unchanged, 20);
  assert.equal(second.merge.deletion_candidates, 0);

  const repeated = plain(core.mergeCumulativeCatalog(second.catalog, boundedRun({
    startPage: 6,
    posts: nextHundred,
    runId: "coverage-3"
  })));
  assert.equal(repeated.catalog.counts.posts, 180);
  assert.equal(repeated.merge.posts_added, 0);
});

test("incremental import classification never proposes delete or unpublish", () => {
  const post = cumulativePost(0, 1);
  const changed = { ...post, title: "Changed title" };
  const newPost = cumulativePost(1, 1);
  const result = plain(core.classifyIncrementalCatalog(
    { posts: [post, newPost], creators: [] },
    { posts: [changed, cumulativePost(99, 1)], creators: [] }
  ));
  assert.deepEqual(result.posts, {
    NEW: 1,
    EXISTING_IDENTICAL: 0,
    UPDATE_NEEDED: 1,
    CONFLICT: 0
  });
  assert.equal(result.deletes, 0);
  assert.equal(result.unpublishes, 0);
});

test("navigation-safe new collection commits pages 1-5 exactly once", async () => {
  const harness = navigationHarness({ startPage: 1 });
  const result = plain(await core.executeNavigationSafeRun({
    operation_id: "new-pages-1-5",
    max_pages: 5,
    expected_scope_key: harness.scope.key,
    expected_start_page: 1,
    ...harness.adapters
  }));
  assert.deepEqual(
    result.page_snapshots.map((page) => core.collectionContextFromUrl(page.source_page_url).page),
    [1, 2, 3, 4, 5]
  );
  assert.equal(result.stop_reason, "MAX_PAGE_LIMIT_REACHED");
  assert.equal(harness.commitCount, 1);
  assert.equal(harness.navigationCount, 4);
  for (let index = 0; index < 4; index += 1) {
    assert.match(harness.trace[index * 2], /^ACK:/);
    assert.match(harness.trace[index * 2 + 1], /^NAVIGATE:/);
  }
});

test("visible-next resume starts at page 6 and collects pages 6-10 after full document reloads", async () => {
  const harness = navigationHarness({ startPage: 5, fullReloadClosedPolls: 2 });
  const result = plain(await core.executeNavigationSafeRun({
    operation_id: "resume-pages-6-10",
    max_pages: 5,
    expected_scope_key: harness.scope.key,
    resume_from_snapshot: navigationSnapshot(5),
    resume_from_page: 5,
    ...harness.adapters
  }));
  assert.deepEqual(
    result.page_snapshots.map((page) => core.collectionContextFromUrl(page.source_page_url).page),
    [6, 7, 8, 9, 10]
  );
  assert.equal(harness.commitCount, 1);
  assert.equal(harness.trace[0], "ACK:PREPARE_RESUME:5");
  assert.equal(harness.trace[1], "NAVIGATE:5->6");
  assert.equal(harness.clock.elapsed(), 2500);
});

test("a third bounded resume starts at page 11 and collects pages 11-15", async () => {
  const harness = navigationHarness({ startPage: 10 });
  const result = plain(await core.executeNavigationSafeRun({
    operation_id: "resume-pages-11-15",
    max_pages: 5,
    expected_scope_key: harness.scope.key,
    resume_from_snapshot: navigationSnapshot(10),
    resume_from_page: 10,
    ...harness.adapters
  }));
  assert.deepEqual(
    result.page_snapshots.map((page) => core.collectionContextFromUrl(page.source_page_url).page),
    [11, 12, 13, 14, 15]
  );
  assert.equal(harness.commitCount, 1);
});

test("SPA navigation reconnects immediately without requiring a long-lived message channel", async () => {
  const harness = navigationHarness({ startPage: 1, fullReloadClosedPolls: 0 });
  const result = plain(await core.executeNavigationSafeRun({
    operation_id: "spa-navigation",
    max_pages: 2,
    expected_scope_key: harness.scope.key,
    expected_start_page: 1,
    ...harness.adapters
  }));
  assert.equal(result.pages_collected, 2);
  assert.equal(harness.clock.elapsed(), 0);
  assert.equal(harness.commitCount, 1);
});

test("URL change with stale DOM waits for a new fingerprint before accepting the page", async () => {
  const harness = navigationHarness({ startPage: 1, staleDomPolls: 2 });
  const result = plain(await core.executeNavigationSafeRun({
    operation_id: "stale-dom",
    max_pages: 2,
    expected_scope_key: harness.scope.key,
    expected_start_page: 1,
    ...harness.adapters
  }));
  assert.equal(result.pages_collected, 2);
  assert.equal(harness.clock.elapsed(), 500);
  assert.equal(harness.commitCount, 1);
});

test("expected page mismatch fails closed with its operation stage and does not commit", async () => {
  const harness = navigationHarness({ startPage: 1, pageMismatchAtPage: 1 });
  await assert.rejects(
    core.executeNavigationSafeRun({
      operation_id: "page-mismatch",
      max_pages: 5,
      expected_scope_key: harness.scope.key,
      expected_start_page: 1,
      ...harness.adapters
    }),
    (error) => {
      assert.equal(error.operation_id, "page-mismatch");
      assert.equal(error.operation_stage, "VALIDATE_NEXT_PAGE");
      assert.equal(error.code, "EXPECTED_PAGE_MISMATCH");
      return true;
    }
  );
  assert.equal(harness.commitCount, 0);
});

test("unchanged fingerprints time out fail-closed without committing partial pages", async () => {
  const persistedCheckpoint = { cumulative_unique_post_count: 100, updated_at: "before-run" };
  const harness = navigationHarness({ startPage: 1, staleDomPolls: 20, timeoutMs: 1000 });
  await assert.rejects(
    core.executeNavigationSafeRun({
      operation_id: "duplicate-timeout",
      max_pages: 5,
      expected_scope_key: harness.scope.key,
      expected_start_page: 1,
      ...harness.adapters
    }),
    (error) => {
      assert.equal(error.operation_stage, "VALIDATE_NEXT_PAGE");
      assert.equal(error.code, "PAGE_FINGERPRINT_UNCHANGED");
      return true;
    }
  );
  assert.equal(harness.commitCount, 0);
  assert.deepEqual(persistedCheckpoint, { cumulative_unique_post_count: 100, updated_at: "before-run" });
});

test("channel close after navigation ACK is transient, while close before ACK is fatal", async () => {
  const afterAck = navigationHarness({ startPage: 1, fullReloadClosedPolls: 1 });
  const successful = plain(await core.executeNavigationSafeRun({
    operation_id: "close-after-ack",
    max_pages: 2,
    expected_scope_key: afterAck.scope.key,
    expected_start_page: 1,
    ...afterAck.adapters
  }));
  assert.equal(successful.pages_collected, 2);
  assert.equal(afterAck.commitCount, 1);

  const beforeAck = navigationHarness({ startPage: 1, channelCloseBeforeAckAtPage: 1 });
  await assert.rejects(
    core.executeNavigationSafeRun({
      operation_id: "close-before-ack",
      max_pages: 2,
      expected_scope_key: beforeAck.scope.key,
      expected_start_page: 1,
      ...beforeAck.adapters
    }),
    (error) => {
      assert.equal(error.operation_stage, "PREPARE_NEXT");
      assert.equal(error.code, "CHANNEL_CLOSED_BEFORE_ACK");
      return true;
    }
  );
  assert.equal(beforeAck.commitCount, 0);
});

test("login, anti-bot, and modal stops preserve the old cumulative state after a partial run", async () => {
  for (const stopReason of ["LOGIN_REDIRECT", "RATE_LIMIT_OR_ANTI_BOT", "UNEXPECTED_MODAL"]) {
    const persistedCatalog = { counts: { posts: 100 }, marker: "unchanged" };
    const harness = navigationHarness({
      startPage: 1,
      safetyStopPage: 4,
      safetyStopReason: stopReason
    });
    await assert.rejects(
      core.executeNavigationSafeRun({
        operation_id: `safety-${stopReason}`,
        max_pages: 5,
        expected_scope_key: harness.scope.key,
        expected_start_page: 1,
        ...harness.adapters
      }),
      (error) => {
        assert.equal(error.operation_stage, "VALIDATE_NEXT_PAGE");
        assert.equal(error.code, stopReason);
        return true;
      }
    );
    assert.equal(harness.commitCount, 0);
    assert.deepEqual(persistedCatalog, { counts: { posts: 100 }, marker: "unchanged" });
  }
});

test("collector 0.3.2 resumes saved 0.2.x and 0.3.x checkpoints without mutating them", () => {
  const first = plain(core.mergeCumulativeCatalog(null, boundedRun({
    startPage: 1,
    posts: Array.from({ length: 5 }, (_, index) => cumulativePost(index, index + 1)),
    runId: "legacy-checkpoint"
  }))).catalog;
  const checkpoint = plain(first.checkpoint_summary);
  checkpoint.collector_version = "0.2.0";
  const frozenBefore = JSON.stringify(checkpoint);
  const plan = plain(core.validateResumeCheckpoint(checkpoint, first.collection_scope));
  assert.equal(plan.page, 6);
  assert.equal(JSON.stringify(checkpoint), frozenBefore);
  assert.doesNotThrow(
    () => core.validateResumeCheckpoint({ ...checkpoint, collector_version: "0.3.0" }, first.collection_scope)
  );
  assert.doesNotThrow(
    () => core.validateResumeCheckpoint({ ...checkpoint, collector_version: "0.3.1" }, first.collection_scope)
  );
  assert.throws(
    () => core.validateResumeCheckpoint({ ...checkpoint, collector_version: "0.1.8" }, first.collection_scope),
    /CHECKPOINT_COLLECTOR_VERSION_MISMATCH/
  );
});
