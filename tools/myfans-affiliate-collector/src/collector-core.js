(function installMyFansCollectorCore(global) {
  "use strict";

  const COLLECTOR_VERSION = "0.3.2";
  const SCHEMA_VERSION = "myfans-affiliate-catalog-local-v1";
  const CHECKPOINT_SCHEMA_VERSION = "myfans-affiliate-checkpoint-v1";
  const CUMULATIVE_SCHEMA_VERSION = "myfans-affiliate-cumulative-v1";
  const MAX_RUN_PAGES = 5;
  const RESUMABLE_CHECKPOINT_COLLECTOR_VERSIONS = new Set(["0.2.0", "0.2.1", "0.3.0", "0.3.1", COLLECTOR_VERSION]);
  const OPERATION_STAGES = Object.freeze({
    PREPARE_RESUME: "PREPARE_RESUME",
    COLLECT_PAGE: "COLLECT_PAGE",
    PREPARE_NEXT: "PREPARE_NEXT",
    WAIT_NEW_DOCUMENT: "WAIT_NEW_DOCUMENT",
    VALIDATE_NEXT_PAGE: "VALIDATE_NEXT_PAGE",
    COMMIT_RUN: "COMMIT_RUN"
  });
  const AFFILIATE_HOST = "www.affiliate.myfans.jp";
  const PUBLIC_MYFANS_HOSTS = new Set(["myfans.jp", "www.myfans.jp"]);
  const PUBLIC_SOCIAL_HOSTS = new Set([
    "facebook.com",
    "instagram.com",
    "linktr.ee",
    "lit.link",
    "tiktok.com",
    "threads.net",
    "twitter.com",
    "www.facebook.com",
    "www.instagram.com",
    "www.tiktok.com",
    "www.youtube.com",
    "x.com",
    "youtube.com"
  ]);
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const USERNAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
  const RESERVED_PROFILE_SEGMENTS = new Set([
    "affiliates",
    "auth",
    "gachas",
    "help",
    "login",
    "posts",
    "ranking",
    "register",
    "search",
    "signin",
    "signup",
    "terms"
  ]);
  const KNOWN_SAFE_LABELS = new Set([
    "次へ",
    "次のページ",
    "投稿のアフィURL",
    "プロフィールURL",
    "コピー",
    "新しい順",
    "古い順",
    "いいね数",
    "報酬率が高い順",
    "報酬額が高い順"
  ]);
  const FORBIDDEN_EXPORT_KEY_RE = /^(?:account_id|account_name|affiliate_id|avatar(?:_url)?|bank(?:_information)?|cookie|dom_html|email|har|headers|html|identity_document|image(?:_src|_url)?|img|local_storage|media_blob|ogp(?:_url)?|password|poster(?:_url)?|raw_dom|raw_html|revenue|session|session_storage|src|thumbnail(?:_url)?|token|video_url)$/i;
  const COLLECTION_SCOPE_QUERY_KEYS = new Set([
    "genre_id",
    "genre_name",
    "keyword",
    "media_type",
    "q",
    "query",
    "sexual_orientation",
    "sort"
  ]);
  const VOLATILE_RECORD_FIELDS = new Set([
    "collected_at",
    "parser_confidence",
    "source_page_url",
    "source_surface",
    "title_diagnostic"
  ]);

  function normalizeSpace(value) {
    return String(value ?? "")
      .replace(/[\u00a0\u200b-\u200d\ufeff]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeLabel(value) {
    return normalizeSpace(value).replace(/[：:]/g, " ");
  }

  function parseUrl(value, base) {
    try {
      return new URL(value, base);
    } catch {
      return null;
    }
  }

  function isSafeHttpsUrl(url) {
    return Boolean(
      url &&
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        (!url.port || url.port === "443")
    );
  }

  function parsePostUrl(value) {
    const url = parseUrl(value);
    if (!isSafeHttpsUrl(url) || !PUBLIC_MYFANS_HOSTS.has(url.hostname)) return null;
    const match = url.pathname.match(/^\/posts\/([^/]+)\/?$/);
    if (!match || !UUID_RE.test(match[1])) return null;
    const postUuid = match[1].toLowerCase();
    return {
      post_uuid: postUuid,
      post_public_url: `https://myfans.jp/posts/${postUuid}`
    };
  }

  function parseCreatorProfileUrl(value) {
    const url = parseUrl(value);
    if (!isSafeHttpsUrl(url) || !PUBLIC_MYFANS_HOSTS.has(url.hostname)) return null;
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== 1) return null;
    const username = decodeURIComponent(segments[0]);
    if (!USERNAME_RE.test(username) || RESERVED_PROFILE_SEGMENTS.has(username.toLowerCase())) return null;
    return {
      username,
      profile_url: `https://myfans.jp/${encodeURIComponent(username)}`
    };
  }

  function parseAffiliateCreatorRoute(value) {
    const url = parseUrl(value);
    if (!isSafeHttpsUrl(url) || url.hostname !== AFFILIATE_HOST) return null;
    const match = url.pathname.match(/^\/affiliates\/search\/creators\/([^/]+)\/?$/);
    if (!match) return null;
    const username = decodeURIComponent(match[1]);
    if (!USERNAME_RE.test(username) || username.toLowerCase() === "tab") return null;
    return { username };
  }

  function parseDisplayedAffiliateUrl(value) {
    const url = parseUrl(value);
    if (!isSafeHttpsUrl(url)) return null;
    if (url.hostname !== "link.affiliate.myfans.jp") return null;
    return url.href;
  }

  function parseUsernameFromText(text) {
    const match = normalizeSpace(text).match(/(?:^|\s)@([A-Za-z0-9_.-]{1,64})(?=\s|$)/);
    return match ? match[1] : null;
  }

  function parseInteger(value) {
    const compact = String(value ?? "").replace(/[,，\s]/g, "");
    if (!/^\d+$/.test(compact)) return null;
    const parsed = Number.parseInt(compact, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  function parseLabeledNumber(text, labels) {
    const normalized = normalizeLabel(text);
    for (const label of labels) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const after = normalized.match(new RegExp(`${escaped}[^0-9]{0,16}([0-9][0-9,，]*)`, "i"));
      if (after) return parseInteger(after[1]);
      const before = normalized.match(new RegExp(`([0-9][0-9,，]*)[^0-9]{0,8}${escaped}`, "i"));
      if (before) return parseInteger(before[1]);
    }
    return null;
  }

  function parseLabeledYen(text, labels) {
    const normalized = normalizeLabel(text);
    for (const label of labels) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = normalized.match(
        new RegExp(`${escaped}[^0-9¥￥]{0,20}[¥￥]?\\s*([0-9][0-9,，]*)\\s*円?`, "i")
      );
      if (match) return parseInteger(match[1]);
    }
    return null;
  }

  function parseLabeledRate(text, labels) {
    const normalized = normalizeLabel(text);
    for (const label of labels) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = normalized.match(new RegExp(`${escaped}[^0-9]{0,20}([0-9]+(?:\\.[0-9]+)?)\\s*%`, "i"));
      if (match) return Number.parseFloat(match[1]);
    }
    return null;
  }

  function parseEstimatedReward(text) {
    const normalized = normalizeSpace(text);
    const parentheticalAmount = normalized.match(
      /(?:アフィ(?:リエイト)?報酬率|報酬率|報酬単価)[^0-9%]{0,20}[0-9]+(?:\.[0-9]+)?\s*%\s*[（(]\s*[¥￥]\s*([0-9][0-9,，]*)\s*円?\s*[）)]/
    );
    if (parentheticalAmount) return parseInteger(parentheticalAmount[1]);

    for (const label of ["推定報酬", "見込報酬", "報酬額"]) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const explicitAmount = normalized.match(
        new RegExp(
          `${escaped}[^0-9¥￥%]{0,12}(?:[（(]\\s*)?(?:[¥￥]\\s*([0-9][0-9,，]*)|([0-9][0-9,，]*)\\s*円)`,
          "i"
        )
      );
      if (explicitAmount) return parseInteger(explicitAmount[1] || explicitAmount[2]);
    }
    return null;
  }

  function parseDuration(text) {
    const matches = normalizeSpace(text).match(/(?:^|\s)(\d{1,2}:\d{2}(?::\d{2})?)(?=\s|$)/g);
    if (!matches || matches.length === 0) return null;
    const raw = normalizeSpace(matches[0]);
    const pieces = raw.split(":").map((part) => Number.parseInt(part, 10));
    if (pieces.some((part) => !Number.isFinite(part))) return null;
    let seconds;
    if (pieces.length === 2) {
      if (pieces[1] > 59) return null;
      seconds = pieces[0] * 60 + pieces[1];
    } else {
      if (pieces[1] > 59 || pieces[2] > 59) return null;
      seconds = pieces[0] * 3600 + pieces[1] * 60 + pieces[2];
    }
    return { video_duration: raw, video_duration_seconds: seconds };
  }

  function parseRelativePublishedText(text) {
    const normalized = normalizeSpace(text);
    const match = normalized.match(/(?:たった今|昨日|\d+\s*(?:秒|分|時間|日|週間|週|か月|ヶ月|月|年)前)/);
    return match ? normalizeSpace(match[0]) : null;
  }

  function cleanCreatorName(value) {
    const normalized = normalizeSpace(value);
    if (!normalized) return null;
    const cleaned = normalized.replace(
      /\s+(?:たった今|昨日|\d+\s*(?:秒|分|時間|日|週間|週|か月|ヶ月|月|年)前)$/,
      ""
    ).trim();
    return cleaned || null;
  }

  function firstMeaningfulTitle(candidates) {
    const blocked = /^(?:@|次へ$|コピー$|投稿のアフィURL$|プロフィールURL$|\d{1,2}:\d{2}(?::\d{2})?$)/;
    for (const candidate of candidates || []) {
      const value = normalizeSpace(candidate);
      if (value.length >= 2 && value.length <= 300 && !blocked.test(value)) return value;
    }
    return null;
  }

  const TITLE_STRATEGIES = new Set([
    "ANCHOR_ATTRIBUTE",
    "SEMANTIC",
    "POST_LINK",
    "NEARBY_SEMANTIC",
    "CARD_ORDERED_SEGMENT_WINDOW",
    "CARD_ORDERED_VISIBLE_LEAF"
  ]);
  const STANDARD_TITLE_MAX_LENGTH = 1000;
  const HARD_TITLE_MAX_LENGTH = 10000;
  const SAFE_DIAGNOSTIC_TAGS = new Set([
    "a",
    "article",
    "button",
    "div",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "img",
    "li",
    "main",
    "p",
    "section",
    "span",
    "svg",
    "video"
  ]);

  function scorePostCardContainerCandidate(candidate) {
    const postLinkCount = Number.isSafeInteger(candidate?.post_link_count)
      ? candidate.post_link_count
      : 0;
    const textLength = Number.isSafeInteger(candidate?.text_length)
      ? candidate.text_length
      : 0;
    if (!candidate?.contains_target_post || postLinkCount !== 1 || candidate?.is_page_level) {
      return { eligible: false, score: -10000 };
    }
    if (textLength > 8000) return { eligible: false, score: -10000 };

    let score = 20;
    if (candidate.has_price_signal) score += 5;
    if (candidate.has_reward_signal) score += 6;
    if (candidate.has_affiliate_copy_action) score += 24;
    if (candidate.has_profile_action) score += 3;
    if (candidate.has_creator_signal) score += 8;
    if (candidate.has_relative_date_signal) score += 4;
    if (candidate.has_duration_signal) score += 2;
    if (candidate.has_post_action) score += 6;
    if (candidate.has_price_signal && candidate.has_reward_signal) score += 4;
    if (candidate.has_affiliate_copy_action && candidate.has_creator_signal) score += 8;
    if ((candidate.title_window_candidate_count || 0) > 0) score += 30;
    if (textLength >= 12 && textLength <= 3000) score += 2;
    if (textLength > 3500) score -= 30;
    if (candidate.has_page_navigation) score -= 40;
    if (candidate.has_category_ui) score -= 20;
    return { eligible: true, score };
  }

  function selectPostCardContainerCandidate(candidates) {
    const scored = (candidates || [])
      .map((candidate, candidateIndex) => {
        const result = scorePostCardContainerCandidate(candidate);
        return {
          ...candidate,
          candidate_index: candidateIndex,
          selected_container_score: result.score,
          eligible: result.eligible
        };
      })
      .filter((candidate) => candidate.eligible)
      .sort((left, right) => {
        if (right.selected_container_score !== left.selected_container_score) {
          return right.selected_container_score - left.selected_container_score;
        }
        return (left.depth || 0) - (right.depth || 0);
      });
    return scored[0] || null;
  }

  function titleCandidateDescriptor(candidate, fallbackStrategy) {
    const descriptor =
      candidate && typeof candidate === "object"
        ? candidate
        : { text: candidate, strategy: fallbackStrategy };
    const strategy = TITLE_STRATEGIES.has(descriptor.strategy)
      ? descriptor.strategy
      : fallbackStrategy;
    return {
      text: normalizeSpace(descriptor.text),
      strategy: TITLE_STRATEGIES.has(strategy) ? strategy : "SEMANTIC"
    };
  }

  function hasSubstantialNaturalTitleText(value, removableValues, removablePatterns) {
    let remainder = normalizeSpace(value);
    for (const removableValue of [...new Set(removableValues || [])]
      .map(normalizeSpace)
      .filter(Boolean)
      .sort((left, right) => right.length - left.length)) {
      remainder = remainder.split(removableValue).join(" ");
    }
    for (const removablePattern of removablePatterns || []) {
      remainder = remainder.replace(removablePattern, " ");
    }
    remainder = remainder
      .replace(/[¥￥]\s*[0-9][0-9,，]*/g, " ")
      .replace(/[0-9]+(?:\.[0-9]+)?\s*%/g, " ")
      .replace(/[0-9][0-9,，]*(?:\s*(?:円|件))?/g, " ")
      .replace(/[\p{P}\p{S}\s_]+/gu, "");
    return (remainder.match(/\p{L}/gu) || []).length >= 6;
  }

  function hasSafeStrongWindowLongTitleText(value, excluded) {
    return hasSubstantialNaturalTitleText(value, excluded, [
      /(?:たった今|昨日|\d+\s*(?:秒|分|時間|日|週間|週|か月|ヶ月|月|年)前)/g,
      /(?:^|\s)\d{1,2}:\d{2}(?::\d{2})?(?=\s|$)/g,
      /(?:単品販売価格|販売価格|単品販売|価格)/g,
      /(?:アフィ(?:リエイト)?報酬率|報酬率|報酬単価|推定報酬|見込報酬|報酬額)/g,
      /(?:いいね(?:数|する)?|likes?|hearts?|[♡♥❤]\uFE0F?)/gi,
      /(?:プロフィールURL(?:(?:の|を)?コピー)?|(?:プロフィール|投稿|作品)(?:の)?アフィ(?:リエイト)?URL(?:の|を)?コピー|投稿のアフィURL|アフィURL(?:のコピー)?|(?:URL|リンク)(?:の|を)?コピー(?:しました)?|コピー(?:しました)?)/g,
      /(?:詳細を見る|もっと見る|プロフィールを見る|作品を見る|購入(?:する)?|開く|閉じる|戻る|次へ|前へ|検索|シェア|共有|保存|登録|作成)/g,
      /(?:再生|一時停止|停止|ミュート|ミュート解除|全画面|音量|シーク|play|pause|mute|unmute|fullscreen)/gi,
      /(?:限定|無料|有料|新着|おすすめ|公開|非公開|鍵|ロック|lock|購入済み|販売中|公開中|閲覧可能|new|sale|featured)/gi,
      /(?:https?:\/\/|www\.)[^\s]+/gi
    ]);
  }

  function titleRejectionReason(value, excluded, strictNaturalText, context = {}) {
    if (!value) return "EMPTY";
    if (value.length < 2) return "TOO_SHORT";
    if (value.length > HARD_TITLE_MAX_LENGTH) return "TOO_LONG";
    if (
      value.length > STANDARD_TITLE_MAX_LENGTH &&
      (
        !context.strong_title_window ||
        !hasSafeStrongWindowLongTitleText(value, excluded)
      )
    ) {
      return "TOO_LONG";
    }
    if (/^@/.test(value)) return "USERNAME";
    const matchingExcludedValues = excluded.filter(
      (excludedValue) => excludedValue.length >= 2 && value.includes(excludedValue)
    );
    if (
      matchingExcludedValues.length > 0 &&
      !hasSubstantialNaturalTitleText(value, matchingExcludedValues, [])
    ) {
      return "CREATOR_OR_USERNAME";
    }
    if (/^(?:動画|画像|video|image)$/i.test(value)) return "MEDIA_BADGE";
    if (/^(?:プロフィールURL(?:(?:の|を)?コピー)?|(?:プロフィール|投稿|作品)(?:の)?アフィ(?:リエイト)?URL(?:の|を)?コピー|投稿のアフィURL|アフィURL(?:のコピー)?|(?:URL|リンク)(?:の|を)?コピー(?:しました)?|コピー(?:しました)?)$/.test(value)) {
      return "AFFILIATE_OR_PROFILE_ACTION";
    }
    if (/^(?:詳細を見る|もっと見る|プロフィールを見る|作品を見る|購入(?:する)?|開く|閉じる|戻る|次へ|前へ|検索|シェア|共有|保存|登録|作成)$/.test(value)) {
      return "ACTION_LABEL";
    }
    if (/^(?:再生|一時停止|停止|ミュート|ミュート解除|全画面|音量|シーク|play|pause|mute|unmute|fullscreen)$/i.test(value)) {
      return "MEDIA_CONTROL";
    }
    if (/^(?:限定|無料|有料|新着|おすすめ|公開|非公開|鍵|ロック|lock|購入済み|販売中|公開中|閲覧可能|new|sale|featured)$/i.test(value)) {
      return "BADGE_OR_LOCK_LABEL";
    }
    if (
      /(?:たった今|昨日|\d+\s*(?:秒|分|時間|日|週間|週|か月|ヶ月|月|年)前)/.test(value) &&
      !hasSubstantialNaturalTitleText(
        value,
        [],
        [/(?:たった今|昨日|\d+\s*(?:秒|分|時間|日|週間|週|か月|ヶ月|月|年)前)/g]
      )
    ) {
      return "RELATIVE_DATE";
    }
    if (/(?:^|\s)\d{1,2}:\d{2}(?::\d{2})?(?:\s|$)/.test(value)) return "DURATION";
    if (/^[（(]?\s*[¥￥]\s*[0-9][0-9,，]*\s*円?\s*[）)]?$/.test(value)) {
      return "PRICE_OR_REWARD_AMOUNT";
    }
    if (/^[0-9][0-9,，]*\s*(?:件)?$/.test(value)) return "NUMERIC_ONLY";
    if (/^[0-9]+(?:\.[0-9]+)?\s*%$/.test(value)) return "REWARD_RATE";
    if (
      /(?:単品販売価格|販売価格|単品販売|価格)/.test(value) &&
      !hasSubstantialNaturalTitleText(
        value,
        [],
        [/(?:単品販売価格|販売価格|単品販売|価格)/g]
      )
    ) {
      return "PRICE";
    }
    if (/(?:アフィ(?:リエイト)?報酬率|報酬率|報酬単価|推定報酬|見込報酬|報酬額)/.test(value)) {
      return "REWARD";
    }
    if (
      /(?:いいね|likes?|hearts?|[♡♥❤])/i.test(value) &&
      !hasSubstantialNaturalTitleText(
        value,
        [],
        [/(?:いいね(?:数|する)?|likes?|hearts?|[♡♥❤]\uFE0F?)/gi]
      )
    ) {
      return "LIKES";
    }
    if (/^(?:https?:\/\/|www\.)/i.test(value)) return "URL";
    if (strictNaturalText && !/\p{L}/u.test(value)) return "NON_NATURAL_TEXT";
    return null;
  }

  function normalizedTitleExclusions(excludedCandidates) {
    return [...new Set(
      (excludedCandidates || [])
        .map(normalizeSpace)
        .filter(Boolean)
        .flatMap((value) => [value, value.startsWith("@") ? value.slice(1) : value])
    )];
  }

  function evaluateOrderedSegmentWindow(candidates, excludedCandidates) {
    const excluded = normalizedTitleExclusions(excludedCandidates);
    const baselineEntries = (candidates || []).map((candidate) => {
      const normalized = titleCandidateDescriptor(candidate, "CARD_ORDERED_SEGMENT_WINDOW");
      return {
        ...normalized,
        reason: titleRejectionReason(normalized.text, excluded, true)
      };
    });
    const commercialReasons = new Set([
      "PRICE",
      "REWARD",
      "PRICE_OR_REWARD_AMOUNT",
      "REWARD_RATE"
    ]);
    const closingReasons = new Set([
      "CREATOR_OR_USERNAME",
      "USERNAME",
      "RELATIVE_DATE",
      "AFFILIATE_OR_PROFILE_ACTION",
      "ACTION_LABEL"
    ]);
    const rewardReasons = new Set([
      "REWARD",
      "REWARD_RATE"
    ]);
    const entries = baselineEntries.map((entry, index) => {
      const hasCommercialBefore = baselineEntries
        .slice(0, index)
        .some((candidate) => commercialReasons.has(candidate.reason));
      const hasRewardBefore = baselineEntries
        .slice(0, index)
        .some((candidate) => rewardReasons.has(candidate.reason));
      const hasClosingAfter = baselineEntries
        .slice(index + 1)
        .some((candidate) => closingReasons.has(candidate.reason));
      const segmentWindow = hasCommercialBefore && hasClosingAfter;
      const strongLongTitleWindow = hasRewardBefore && hasClosingAfter;
      return {
        ...entry,
        segment_window: segmentWindow,
        reason: segmentWindow
          ? titleRejectionReason(entry.text, excluded, true, {
              strong_title_window: strongLongTitleWindow
            })
          : entry.reason
      };
    });
    const rejectionReasons = entries.map((entry) => entry.reason).filter(Boolean);
    let selected = null;
    let segmentWindowFound = false;
    let safeCandidateCount = 0;

    for (let index = 0; index < entries.length; index += 1) {
      if (!entries[index].segment_window) continue;
      segmentWindowFound = true;
      if (!entries[index].reason) {
        safeCandidateCount += 1;
        if (!selected) selected = entries[index];
      }
    }

    return {
      title: selected?.text || null,
      chosen_strategy: selected?.strategy || "NONE",
      rejection_reason_codes: [...new Set(rejectionReasons)],
      segment_window_found: segmentWindowFound,
      safe_candidate_count: safeCandidateCount
    };
  }

  function summarizePostTitleSegmentWindow(candidates, excludedCandidates) {
    const result = evaluateOrderedSegmentWindow(candidates, excludedCandidates);
    return {
      segment_window_found: result.segment_window_found,
      safe_candidate_count: result.safe_candidate_count
    };
  }

  function sanitizeDiagnosticVisibleText(value) {
    let text = normalizeSpace(value);
    if (!text) return "";
    text = text
      .replace(/<\/?[a-z][^>]*>/gi, "[MARKUP_REDACTED]")
      .replace(/(?:https?:\/\/|www\.)[^\s]+/gi, "[URL_REDACTED]")
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL_REDACTED]")
      .replace(
        /\b(?:authorization|cookie|password|session|token)\s*[:=]\s*[^\s]+/gi,
        "[CREDENTIAL_REDACTED]"
      );
    if (/(?:口座番号|銀行情報|本人確認|アフィリエイトID|affiliate\s*id|account\s*id)/i.test(text)) {
      return "[ACCOUNT_DATA_REDACTED]";
    }
    return text.slice(0, 300);
  }

  function diagnosticRegionForEntry(entries, index) {
    const commercialReasons = new Set([
      "PRICE",
      "REWARD",
      "PRICE_OR_REWARD_AMOUNT",
      "REWARD_RATE"
    ]);
    const closingReasons = new Set([
      "CREATOR_OR_USERNAME",
      "USERNAME",
      "RELATIVE_DATE",
      "AFFILIATE_OR_PROFILE_ACTION",
      "ACTION_LABEL"
    ]);
    const commercialIndexes = entries
      .map((entry, entryIndex) => commercialReasons.has(entry.reason) ? entryIndex : -1)
      .filter((entryIndex) => entryIndex >= 0);
    const closingIndexes = entries
      .map((entry, entryIndex) => closingReasons.has(entry.reason) ? entryIndex : -1)
      .filter((entryIndex) => entryIndex >= 0);
    const firstCommercial = commercialIndexes[0] ?? -1;
    const lastCommercial = commercialIndexes.at(-1) ?? -1;
    const firstClosingAfterCommercial = closingIndexes.find((entryIndex) => entryIndex > lastCommercial) ?? -1;
    const lastClosing = closingIndexes.at(-1) ?? -1;
    const reason = entries[index]?.reason;

    if (commercialReasons.has(reason)) return "PRICE_REWARD";
    if (closingReasons.has(reason)) return "CREATOR_DATE_ACTION";
    if (firstCommercial >= 0 && index < firstCommercial) return "BEFORE_PRICE";
    if (
      lastCommercial >= 0 &&
      firstClosingAfterCommercial >= 0 &&
      index > lastCommercial &&
      index < firstClosingAfterCommercial
    ) {
      return "BETWEEN_REWARD_AND_CREATOR";
    }
    if (
      firstClosingAfterCommercial >= 0 &&
      lastClosing >= firstClosingAfterCommercial &&
      index >= firstClosingAfterCommercial &&
      index <= lastClosing
    ) {
      return "CREATOR_DATE_ACTION";
    }
    if (lastClosing >= 0 && index > lastClosing) return "AFTER_ACTION";
    return "UNKNOWN";
  }

  function sanitizedVisibleSegmentDiagnostics(candidates, excludedCandidates) {
    const excluded = normalizedTitleExclusions(excludedCandidates);
    const entries = (candidates || []).slice(0, 30).map((candidate, index) => {
      const normalized = titleCandidateDescriptor(candidate, "CARD_ORDERED_SEGMENT_WINDOW");
      return {
        order: Number.isSafeInteger(candidate?.segment_order)
          ? Math.max(1, Math.min(candidate.segment_order, 1000))
          : index + 1,
        text: sanitizeDiagnosticVisibleText(normalized.text),
        reason: titleRejectionReason(normalized.text, excluded, true)
      };
    });
    return entries.map((entry, index) => ({
      order: entry.order,
      text: entry.text,
      rejection_reason: entry.reason,
      region: diagnosticRegionForEntry(entries, index)
    }));
  }

  function sanitizedMissingTitleAncestorContext(context) {
    const safeCount = (value, maximum) =>
      Number.isSafeInteger(value) ? Math.max(0, Math.min(value, maximum)) : 0;
    const eligibleAncestors = (context?.eligible_ancestors || []).slice(0, 10).map((candidate) => ({
      depth: safeCount(candidate?.depth, 10),
      score: Number.isFinite(candidate?.score)
        ? Math.max(-10000, Math.min(candidate.score, 10000))
        : 0,
      post_link_count: safeCount(candidate?.post_link_count, 100),
      safe_title_candidate_count: safeCount(candidate?.safe_title_candidate_count, 1000),
      ordered_segment_count: safeCount(candidate?.ordered_segment_count, 1000),
      has_price_signal: Boolean(candidate?.has_price_signal),
      has_reward_signal: Boolean(candidate?.has_reward_signal),
      has_creator_signal: Boolean(candidate?.has_creator_signal),
      has_affiliate_copy_action: Boolean(candidate?.has_affiliate_copy_action)
    }));
    const visibleSegmentAncestors = (context?.visible_segment_ancestors || [])
      .slice(0, 3)
      .map((candidate) => ({
        depth: safeCount(candidate?.depth, 10),
        selected: Boolean(candidate?.selected),
        segments: sanitizedVisibleSegmentDiagnostics(
          candidate?.segments,
          candidate?.excluded_candidates
        )
      }));
    return { eligibleAncestors, visibleSegmentAncestors };
  }

  function selectPostTitle(primaryCandidates, segmentCandidates, leafCandidates, excludedCandidates) {
    const excluded = normalizedTitleExclusions(excludedCandidates);
    const rejectionReasons = [];
    const primary = primaryCandidates || [];
    const segments = segmentCandidates || [];
    const fallback = leafCandidates || [];
    const candidateCount = primary.length + segments.length + fallback.length;

    for (const candidate of primary) {
      const normalized = titleCandidateDescriptor(candidate, "SEMANTIC");
      const reason = titleRejectionReason(normalized.text, excluded, false);
      if (!reason) {
        return {
          title: normalized.text,
          chosen_strategy: normalized.strategy,
          candidate_count: candidateCount,
          rejection_reason_codes: [...new Set(rejectionReasons)],
          segment_window_found: false
        };
      }
      rejectionReasons.push(reason);
    }

    const segmentResult = evaluateOrderedSegmentWindow(segments, excludedCandidates);
    rejectionReasons.push(...segmentResult.rejection_reason_codes);
    if (segmentResult.title) {
      return {
        title: segmentResult.title,
        chosen_strategy: segmentResult.chosen_strategy,
        candidate_count: candidateCount,
        rejection_reason_codes: [...new Set(rejectionReasons)],
        segment_window_found: true
      };
    }

    for (const candidate of fallback) {
      const normalized = titleCandidateDescriptor(candidate, "CARD_ORDERED_VISIBLE_LEAF");
      const reason = titleRejectionReason(normalized.text, excluded, true);
      if (!reason) {
        return {
          title: normalized.text,
          chosen_strategy: normalized.strategy,
          candidate_count: candidateCount,
          rejection_reason_codes: [...new Set(rejectionReasons)],
          segment_window_found: segmentResult.segment_window_found
        };
      }
      rejectionReasons.push(reason);
    }

    return {
      title: null,
      chosen_strategy: "NONE",
      candidate_count: candidateCount,
      rejection_reason_codes: [...new Set(rejectionReasons)],
      segment_window_found: segmentResult.segment_window_found,
      title_missing_reason:
        candidateCount === 0
          ? "NO_VISIBLE_TITLE_CANDIDATES"
          : "NO_SAFE_NATURAL_TEXT_AFTER_METADATA_FILTER"
    };
  }

  function sanitizedTitleDiagnostic(postUuid, selection, context) {
    const textNodeCount = Number.isSafeInteger(context?.text_node_count)
      ? Math.max(0, Math.min(context.text_node_count, 1000))
      : 0;
    const anonymizedTagSequence = (context?.anonymized_tag_sequence || [])
      .slice(0, 80)
      .map((tag) => normalizeSpace(tag).toLowerCase())
      .map((tag) => (SAFE_DIAGNOSTIC_TAGS.has(tag) ? tag : "other"));
    const safeCount = (value, maximum) =>
      Number.isSafeInteger(value) ? Math.max(0, Math.min(value, maximum)) : 0;
    const diagnostic = {
      post_uuid: postUuid,
      text_node_count: textNodeCount,
      anonymized_dom_tag_sequence: anonymizedTagSequence,
      candidate_count: selection.candidate_count,
      rejection_reason_codes: selection.rejection_reason_codes,
      chosen_strategy: selection.chosen_strategy,
      title_missing_reason: selection.title_missing_reason,
      selected_container_depth: safeCount(context?.selected_container_depth, 10),
      selected_container_score: Number.isFinite(context?.selected_container_score)
        ? Math.max(-10000, Math.min(context.selected_container_score, 10000))
        : 0,
      post_link_count: safeCount(context?.post_link_count, 100),
      has_price_signal: Boolean(context?.has_price_signal),
      has_reward_signal: Boolean(context?.has_reward_signal),
      has_affiliate_copy_action: Boolean(context?.has_affiliate_copy_action),
      has_creator_signal: Boolean(context?.has_creator_signal),
      ordered_segment_count: safeCount(context?.ordered_segment_count, 1000),
      segment_window_found: Boolean(selection.segment_window_found),
      missing_reason: selection.title_missing_reason
    };
    const ancestorContext = sanitizedMissingTitleAncestorContext(context);
    if (ancestorContext.eligibleAncestors.length > 0) {
      diagnostic.eligible_ancestors = ancestorContext.eligibleAncestors;
    }
    if (ancestorContext.visibleSegmentAncestors.length > 0) {
      diagnostic.visible_segment_ancestors = ancestorContext.visibleSegmentAncestors;
    }
    return diagnostic;
  }

  function parseLikes(candidates) {
    for (const candidate of candidates || []) {
      const value = normalizeSpace(candidate);
      const labeledAfter = value.match(
        /(?:^|\s)(?:いいね(?:数|する)?|likes?|hearts?)\s*[:：]?\s*([0-9][0-9,，]*)\s*(?:件)?(?=$|\s)/i
      );
      if (labeledAfter) return parseInteger(labeledAfter[1]);
      const labeledBefore = value.match(
        /(?:^|\s)([0-9][0-9,，]*)\s*(?:件\s*)?(?:いいね(?:数)?|likes?|hearts?)(?=$|\s)/i
      );
      if (labeledBefore) return parseInteger(labeledBefore[1]);
      const heart = value.match(/(?:^|\s)[♡♥❤]\uFE0F?\s*([0-9][0-9,，]*)(?=$|\s)/);
      if (heart) return parseInteger(heart[1]);
    }
    return null;
  }

  function visibleLinks(descriptor) {
    return Array.isArray(descriptor.links)
      ? descriptor.links.filter((link) => link && link.visible !== false && typeof link.href === "string")
      : [];
  }

  function parseExternalSocialLinks(links) {
    const output = [];
    const seen = new Set();
    for (const link of links || []) {
      const url = parseUrl(link.href);
      if (!isSafeHttpsUrl(url)) continue;
      if (PUBLIC_MYFANS_HOSTS.has(url.hostname) || /(?:^|\.)affiliate\.myfans\.jp$/i.test(url.hostname)) continue;
      if (!PUBLIC_SOCIAL_HOSTS.has(url.hostname.toLowerCase())) continue;
      if (/\.(?:avif|gif|jpe?g|png|svg|webp)(?:$|[?#])/i.test(url.pathname)) continue;
      const canonical = url.href;
      if (!seen.has(canonical)) {
        seen.add(canonical);
        output.push(canonical);
      }
    }
    return output;
  }

  function inferMediaType(text, duration) {
    const normalized = normalizeSpace(text).toLowerCase();
    if (duration || /(?:^|\s)(?:動画|video)(?:\s|$)/i.test(normalized)) return "video";
    if (/(?:^|\s)(?:画像|image)(?:\s|$)/i.test(normalized)) return "image";
    return "unknown";
  }

  function confidenceFromEvidence(required, optional) {
    if (required.every(Boolean) && optional.filter(Boolean).length >= 2) return "HIGH";
    if (required.every(Boolean)) return "MEDIUM";
    return "LOW";
  }

  function extractPostFromDescriptor(descriptor) {
    const identity = parsePostUrl(descriptor.post_href);
    if (!identity) return null;
    const text = normalizeSpace(descriptor.text);
    const links = visibleLinks(descriptor);
    const profile = links.map((link) => parseCreatorProfileUrl(link.href)).find(Boolean) || null;
    const affiliateCreatorRoute = links.map((link) => parseAffiliateCreatorRoute(link.href)).find(Boolean) || null;
    const duration = parseDuration(text);
    const rawCreatorName = firstMeaningfulTitle(descriptor.creator_name_candidates || []);
    const creatorName = cleanCreatorName(rawCreatorName);
    const username = profile?.username || affiliateCreatorRoute?.username || parseUsernameFromText(text);
    const titleSelection = selectPostTitle(
      descriptor.title_candidates || [descriptor.anchor_text],
      descriptor.title_segment_candidates || [],
      descriptor.title_leaf_candidates || [],
      [
        ...(descriptor.creator_name_candidates || []),
        creatorName,
        username,
        username ? `@${username}` : null
      ].filter(Boolean)
    );
    const title = titleSelection.title;
    const displayedAffiliateUrl = links.map((link) => parseDisplayedAffiliateUrl(link.href)).find(Boolean) || null;
    const price = parseLabeledYen(text, ["単品販売価格", "販売価格", "単品販売", "価格"]);
    const estimatedReward = parseEstimatedReward(text);
    const rewardRate = parseLabeledRate(text, ["アフィリエイト報酬率", "アフィ報酬率", "報酬率", "報酬単価"]);
    const likes = parseLikes(
      Array.isArray(descriptor.likes_candidates) ? descriptor.likes_candidates : [text]
    );
    const relativePublishedText = parseRelativePublishedText(text);
    const record = {
      post_uuid: identity.post_uuid,
      post_public_url: identity.post_public_url,
      title,
      creator_name: creatorName,
      creator_username: username,
      creator_profile_url: profile?.profile_url || null,
      price_jpy: price,
      affiliate_reward_rate: rewardRate,
      estimated_reward_jpy: estimatedReward,
      media_type: inferMediaType(text, duration),
      video_duration: duration?.video_duration || null,
      video_duration_seconds: duration?.video_duration_seconds ?? null,
      likes,
      relative_published_text: relativePublishedText,
      affiliate_eligible: true,
      source_surface: descriptor.source_surface,
      source_page_url: descriptor.source_page_url,
      collected_at: descriptor.collected_at,
      parser_confidence: title
        ? confidenceFromEvidence(
            [identity.post_uuid, descriptor.source_surface],
            [title, creatorName || username, price !== null, rewardRate !== null]
          )
        : "MEDIUM"
    };
    if (displayedAffiliateUrl) record.displayed_affiliate_url = displayedAffiliateUrl;
    if (!title) {
      record.title_diagnostic = sanitizedTitleDiagnostic(
        identity.post_uuid,
        titleSelection,
        descriptor.title_diagnostic_context
      );
    }
    return record;
  }

  function extractPlanFromDescriptor(descriptor) {
    const text = normalizeSpace(descriptor.text);
    const planName = firstMeaningfulTitle(descriptor.title_candidates || []);
    const monthlyPrice = parseLabeledYen(text, ["月額", "プラン価格", "価格"]);
    const planPostCount = parseLabeledNumber(text, ["プラン投稿数", "投稿数", "件"]);
    const description = normalizeSpace(descriptor.description || "") || null;
    if (!planName && monthlyPrice === null && planPostCount === null) return null;
    return {
      plan_name: planName,
      monthly_price_jpy: monthlyPrice,
      plan_post_count: planPostCount,
      plan_description: description
    };
  }

  function extractCreatorFromDescriptor(descriptor) {
    const text = normalizeSpace(descriptor.text);
    const links = visibleLinks(descriptor);
    const profile =
      parseCreatorProfileUrl(descriptor.profile_href) ||
      links.map((link) => parseCreatorProfileUrl(link.href)).find(Boolean) ||
      null;
    const affiliateCreatorRoute =
      parseAffiliateCreatorRoute(descriptor.affiliate_creator_href) ||
      parseAffiliateCreatorRoute(descriptor.profile_href) ||
      links.map((link) => parseAffiliateCreatorRoute(link.href)).find(Boolean) ||
      null;
    const username = profile?.username || affiliateCreatorRoute?.username || parseUsernameFromText(text);
    if (!username && !profile) return null;
    const creatorName = cleanCreatorName(firstMeaningfulTitle(descriptor.name_candidates || []));
    const plans = (descriptor.plan_candidates || []).map(extractPlanFromDescriptor).filter(Boolean);
    const record = {
      creator_name: creatorName,
      username,
      profile_url: profile?.profile_url || null,
      likes: parseLabeledNumber(text, ["いいね"]),
      followers: parseLabeledNumber(text, ["フォロワー"]),
      following: parseLabeledNumber(text, ["フォロー"]),
      post_count: parseLabeledNumber(text, ["投稿数"]),
      affiliate_enabled_post_count: parseLabeledNumber(text, ["アフィ設定作品の公開件数", "アフィリエイト利用有効の投稿", "アフィリエイト投稿数"]),
      single_reward_rate: parseLabeledRate(text, ["報酬単価（単品販売）", "単品販売報酬率", "単品販売"]),
      plan_initial_reward_rate: parseLabeledRate(text, ["報酬単価（プラン加入）", "プラン加入報酬率", "プラン加入"]),
      plan_continuation_reward_rate: parseLabeledRate(text, ["プラン継続報酬率", "プラン継続"]),
      plans,
      social_profile_urls: parseExternalSocialLinks(links),
      source_surface: descriptor.source_surface,
      source_page_url: descriptor.source_page_url,
      collected_at: descriptor.collected_at,
      parser_confidence: confidenceFromEvidence(
        [username || profile?.profile_url, descriptor.source_surface],
        [creatorName, recordHasStats(text), profile?.profile_url]
      )
    };
    return record;
  }

  function recordHasStats(text) {
    return /(?:いいね|フォロワー|投稿数|報酬率|報酬単価)/.test(text);
  }

  function sourceSurfaceFromUrl(value) {
    const url = parseUrl(value);
    if (!url || url.hostname !== AFFILIATE_HOST || url.protocol !== "https:") return "unsupported";
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path === "/affiliates/search/creators/tab/registered") return "approved_creator_list";
    if (/^\/affiliates\/search\/creators\/[^/]+$/.test(path)) return "creator_detail";
    if (path === "/affiliates/search/creators") return "creator_list";
    if (/^\/affiliates\/search(?:\/|$)/.test(path)) return "post_search";
    if (/^\/affiliates\/generated(?:\/|$)/.test(path)) return "generated_list";
    return "unsupported";
  }

  function isAllowedPageUrl(value) {
    return sourceSurfaceFromUrl(value) !== "unsupported";
  }

  function detectStopCondition(input) {
    const url = parseUrl(input.url);
    const text = normalizeSpace(input.visible_text || "");
    if (!url || url.protocol !== "https:" || url.hostname !== AFFILIATE_HOST) return "UNSUPPORTED_ORIGIN";
    if (/^\/(?:signin|login)(?:\/|$)/.test(url.pathname) || input.has_login_form) return "LOGIN_REDIRECT";
    if (/(?:CAPTCHA|reCAPTCHA|アクセスが集中|リクエストが多すぎ|Too Many Requests|bot verification|不正なアクセス)/i.test(text)) {
      return "RATE_LIMIT_OR_ANTI_BOT";
    }
    if (input.has_unexpected_modal) return "UNEXPECTED_MODAL";
    if (!isAllowedPageUrl(url.href)) return "UNSUPPORTED_ROUTE";
    return null;
  }

  function hrefPattern(value) {
    if (parsePostUrl(value)) return "MYFANS_POST_UUID";
    if (parseCreatorProfileUrl(value)) return "MYFANS_PROFILE";
    if (parseAffiliateCreatorRoute(value)) return "AFFILIATE_CREATOR_ROUTE";
    if (parseDisplayedAffiliateUrl(value)) return "DISPLAYED_AFFILIATE_URL";
    const url = parseUrl(value);
    if (url && url.protocol === "https:") return "OTHER_HTTPS_REDACTED";
    return "NONE_OR_REDACTED";
  }

  function safeKnownLabel(value) {
    const label = normalizeSpace(value);
    return KNOWN_SAFE_LABELS.has(label) ? label : label ? "REDACTED" : null;
  }

  function makeProbeSummary(input) {
    const elements = (input.elements || []).slice(0, 200).map((element) => ({
      tag: normalizeSpace(element.tag).toLowerCase() || "unknown",
      role: normalizeSpace(element.role) || null,
      aria_label: safeKnownLabel(element.aria_label),
      href_pattern: hrefPattern(element.href),
      button_label: safeKnownLabel(element.button_label),
      hierarchy: (element.hierarchy || []).slice(0, 4).map((item) => ({
        tag: normalizeSpace(item.tag).toLowerCase() || "unknown",
        role: normalizeSpace(item.role) || null
      }))
    }));
    return {
      schema_version: "myfans-affiliate-collector-probe-v1",
      collector_version: COLLECTOR_VERSION,
      source_surface: sourceSurfaceFromUrl(input.source_page_url),
      source_page_url: input.source_page_url,
      collected_at: input.collected_at,
      element_count_observed: input.elements?.length || 0,
      elements,
      field_presence: {
        post_link: elements.some((item) => item.href_pattern === "MYFANS_POST_UUID"),
        creator_profile_link: elements.some((item) => item.href_pattern === "MYFANS_PROFILE"),
        affiliate_creator_route: elements.some((item) => item.href_pattern === "AFFILIATE_CREATOR_ROUTE"),
        displayed_affiliate_link: elements.some((item) => item.href_pattern === "DISPLAYED_AFFILIATE_URL"),
        next_control: elements.some((item) => item.button_label === "次へ" || item.button_label === "次のページ"),
        ...(input.card_field_presence || {})
      },
      values_redacted: true
    };
  }

  function stableHash(value) {
    let hash = 0x811c9dc5;
    const text = String(value);
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function canonicalizeObject(value) {
    if (Array.isArray(value)) return value.map(canonicalizeObject);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalizeObject(value[key])])
    );
  }

  function stableJson(value) {
    return JSON.stringify(canonicalizeObject(value));
  }

  function pageNumberFromUrl(value) {
    const url = parseUrl(value);
    if (!isSafeHttpsUrl(url) || url.hostname !== AFFILIATE_HOST) return null;
    const pageValues = url.searchParams.getAll("page");
    if (pageValues.length > 1) return null;
    const rawPage = pageValues[0] ?? null;
    if (rawPage === null || rawPage === "") return 1;
    if (!/^[1-9]\d*$/.test(rawPage)) return null;
    const page = Number.parseInt(rawPage, 10);
    return Number.isSafeInteger(page) ? page : null;
  }

  function safeCollectionPageUrl(value) {
    const url = parseUrl(value);
    if (!isSafeHttpsUrl(url) || url.hostname !== AFFILIATE_HOST || !isAllowedPageUrl(url.href)) return null;
    if ([...url.searchParams.keys()].some((key) => key !== "page" && !COLLECTION_SCOPE_QUERY_KEYS.has(key))) {
      return null;
    }
    url.hash = "";
    return url.href;
  }

  function canonicalCollectionScope(value) {
    const safeUrl = safeCollectionPageUrl(value);
    const url = parseUrl(safeUrl);
    if (!url) return null;
    const sourceSurface = sourceSurfaceFromUrl(url.href);
    if (!["post_search", "creator_list", "approved_creator_list", "generated_list"].includes(sourceSurface)) {
      return null;
    }
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const parameters = [...url.searchParams.entries()]
      .filter(([key]) => COLLECTION_SCOPE_QUERY_KEYS.has(key))
      .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
        leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey)
      );
    const canonicalUrl = new URL(`https://${AFFILIATE_HOST}${path}`);
    for (const [key, parameterValue] of parameters) canonicalUrl.searchParams.append(key, parameterValue);
    const identity = {
      source_surface: sourceSurface,
      path,
      parameters
    };
    return {
      key: stableHash(stableJson(identity)),
      ...identity,
      canonical_url: canonicalUrl.href
    };
  }

  function collectionContextFromUrl(value) {
    const sourcePageUrl = safeCollectionPageUrl(value);
    const collectionScope = canonicalCollectionScope(sourcePageUrl);
    const page = pageNumberFromUrl(sourcePageUrl);
    if (!sourcePageUrl || !collectionScope || page === null) return null;
    return {
      collection_scope: collectionScope,
      source_page_url: sourcePageUrl,
      page
    };
  }

  function sameCollectionScope(left, right) {
    return Boolean(left?.key && right?.key && left.key === right.key && stableJson(left) === stableJson(right));
  }

  function exactNextPageCandidate(nextControl, collectionScope, lastPageUrl, lastPage) {
    if (!nextControl?.present || nextControl.enabled === false || !nextControl.href) return null;
    const context = collectionContextFromUrl(nextControl.href);
    if (!context || !sameCollectionScope(context.collection_scope, collectionScope)) return null;
    if (context.source_page_url === lastPageUrl || context.page <= lastPage) return null;
    return {
      mode: "EXACT_URL",
      source_page_url: context.source_page_url,
      page: context.page
    };
  }

  function attachCollectionRunMetadata(bundle, options) {
    const pages = bundle?.pages || [];
    if (pages.length === 0) throw new Error("COLLECTION_RUN_HAS_NO_SUCCESSFUL_PAGES");
    const contexts = pages.map((page) => collectionContextFromUrl(page.source_page_url));
    if (contexts.some((context) => !context)) throw new Error("INVALID_COLLECTION_PAGE_CONTEXT");
    const collectionScope = contexts[0].collection_scope;
    if (contexts.some((context) => !sameCollectionScope(context.collection_scope, collectionScope))) {
      throw new Error("COLLECTION_SCOPE_CHANGED_DURING_RUN");
    }
    const startPage = contexts[0].page;
    const lastPage = contexts.at(-1).page;
    if (options?.expected_scope_key && options.expected_scope_key !== collectionScope.key) {
      throw new Error("COLLECTION_SCOPE_MISMATCH");
    }
    if (options?.expected_start_page != null && Number(options.expected_start_page) !== startPage) {
      throw new Error("COLLECTION_START_PAGE_MISMATCH");
    }
    const completionState = bundle.stop_reason === "NEXT_CONTROL_ABSENT_OR_DISABLED"
      ? "COMPLETE"
      : bundle.stop_reason === "MAX_PAGE_LIMIT_REACHED"
        ? "IN_PROGRESS"
        : "INTERRUPTED";
    let nextPageCandidate = null;
    if (completionState !== "COMPLETE") {
      nextPageCandidate = exactNextPageCandidate(
        options?.next_control,
        collectionScope,
        contexts.at(-1).source_page_url,
        lastPage
      );
      if (!nextPageCandidate) {
        nextPageCandidate = {
          mode: "VISIBLE_NEXT_FROM_LAST_PAGE",
          source_page_url: contexts.at(-1).source_page_url,
          page: lastPage
        };
      }
    }
    const runId = normalizeSpace(options?.run_id);
    if (!runId || runId.length > 128) throw new Error("INVALID_COLLECTION_RUN_ID");
    const collectionRun = {
      run_id: runId,
      mode: options?.mode === "RESUME" ? "RESUME" : "NEW",
      collection_scope: collectionScope,
      start_page: startPage,
      last_successfully_collected_page: lastPage,
      next_page_candidate: nextPageCandidate,
      pages_collected_this_run: pages.length,
      completion_state: completionState,
      stop_reason: bundle.stop_reason,
      resume_supported: completionState !== "COMPLETE" && Boolean(nextPageCandidate),
      collected_at: bundle.collected_at
    };
    const enriched = {
      ...bundle,
      export_kind: "RUN",
      collection_scope: collectionScope,
      collection_run: collectionRun
    };
    assertSafeExport(enriched);
    return enriched;
  }

  function validateResumeCheckpoint(checkpoint, currentScope) {
    if (!checkpoint || checkpoint.schema_version !== CHECKPOINT_SCHEMA_VERSION) {
      throw new Error("CHECKPOINT_SCHEMA_MISMATCH");
    }
    if (!RESUMABLE_CHECKPOINT_COLLECTOR_VERSIONS.has(checkpoint.collector_version)) {
      throw new Error("CHECKPOINT_COLLECTOR_VERSION_MISMATCH");
    }
    if (!sameCollectionScope(checkpoint.collection_scope, currentScope)) {
      throw new Error("CHECKPOINT_SCOPE_MISMATCH");
    }
    if (checkpoint.completion_state === "COMPLETE") throw new Error("COLLECTION_SCOPE_ALREADY_COMPLETE");
    if (!checkpoint.resume_supported || !checkpoint.next_page_candidate) {
      throw new Error("CHECKPOINT_NOT_RESUMABLE");
    }
    const candidate = checkpoint.next_page_candidate;
    if (!["EXACT_URL", "VISIBLE_NEXT_FROM_LAST_PAGE"].includes(candidate.mode)) {
      throw new Error("CHECKPOINT_RESUME_MODE_INVALID");
    }
    const context = collectionContextFromUrl(candidate.source_page_url);
    if (!context || !sameCollectionScope(context.collection_scope, currentScope) || context.page !== candidate.page) {
      throw new Error("CHECKPOINT_RESUME_TARGET_INVALID");
    }
    return {
      mode: candidate.mode,
      source_page_url: context.source_page_url,
      page: context.page,
      collection_scope: currentScope
    };
  }

  function comparableRecord(record) {
    return canonicalizeObject(
      Object.fromEntries(
        Object.entries(record || {}).filter(([key]) => !VOLATILE_RECORD_FIELDS.has(key))
      )
    );
  }

  function postCreatorIdentity(post) {
    if (post?.creator_username) return `username:${String(post.creator_username).toLowerCase()}`;
    if (post?.creator_profile_url) return `profile:${post.creator_profile_url}`;
    return null;
  }

  function assertCompatiblePostIdentity(existingPost, observedPost) {
    const existingIdentity = parsePostUrl(existingPost?.post_public_url);
    const observedIdentity = parsePostUrl(observedPost?.post_public_url);
    if (
      !existingIdentity ||
      !observedIdentity ||
      existingIdentity.post_uuid !== observedIdentity.post_uuid ||
      existingIdentity.post_uuid !== observedPost.post_uuid ||
      existingPost.post_uuid !== observedPost.post_uuid
    ) {
      throw new Error(`POST_IDENTITY_CONFLICT:${observedPost?.post_uuid || "UNKNOWN"}`);
    }
    const existingCreator = postCreatorIdentity(existingPost);
    const observedCreator = postCreatorIdentity(observedPost);
    if (existingCreator && observedCreator && existingCreator !== observedCreator) {
      throw new Error(`POST_CREATOR_IDENTITY_CONFLICT:${observedPost.post_uuid}`);
    }
  }

  function creatorFromPost(post) {
    const username = post.creator_username || null;
    const profileUrl = post.creator_profile_url || null;
    if (!username && !profileUrl) return null;
    return {
      creator_name: post.creator_name || null,
      username,
      profile_url: profileUrl,
      likes: null,
      followers: null,
      following: null,
      post_count: null,
      affiliate_enabled_post_count: null,
      single_reward_rate: null,
      plan_initial_reward_rate: null,
      plan_continuation_reward_rate: null,
      plans: [],
      social_profile_urls: [],
      source_surface: post.source_surface,
      source_page_url: post.source_page_url,
      collected_at: post.collected_at,
      parser_confidence: post.parser_confidence
    };
  }

  function mergeCreatorRecord(existingCreator, observedCreator) {
    const merged = { ...existingCreator };
    for (const [key, value] of Object.entries(observedCreator || {})) {
      if (VOLATILE_RECORD_FIELDS.has(key)) {
        merged[key] = value;
      } else if (value == null || value === "" || (Array.isArray(value) && value.length === 0)) {
        if (!(key in merged)) merged[key] = value;
      } else {
        merged[key] = value;
      }
    }
    return merged;
  }

  function observationFor(record, identityField, runId, existingObservation) {
    const identity = record[identityField];
    const collectedAt = record.collected_at;
    return {
      [identityField]: identity,
      first_seen_at: existingObservation?.first_seen_at || collectedAt,
      last_seen_at: collectedAt,
      first_seen_run: existingObservation?.first_seen_run || runId,
      last_seen_run: runId,
      first_seen_source_page_url: existingObservation?.first_seen_source_page_url || record.source_page_url,
      last_seen_source_page_url: record.source_page_url,
      first_seen_collector_version: existingObservation?.first_seen_collector_version || COLLECTOR_VERSION,
      last_seen_collector_version: COLLECTOR_VERSION
    };
  }

  function buildCheckpoint(collectionRun, posts, existingCheckpoint, updatedAt) {
    return {
      schema_version: CHECKPOINT_SCHEMA_VERSION,
      collector_version: COLLECTOR_VERSION,
      collection_scope: collectionRun.collection_scope,
      collection_start_page: existingCheckpoint?.collection_start_page || collectionRun.start_page,
      start_page: collectionRun.start_page,
      last_successfully_collected_page: collectionRun.last_successfully_collected_page,
      next_page_candidate: collectionRun.next_page_candidate,
      pages_collected_this_run: collectionRun.pages_collected_this_run,
      cumulative_unique_post_count: posts.length,
      seen_post_uuids: posts.map((post) => post.post_uuid).sort(),
      created_at: existingCheckpoint?.created_at || updatedAt,
      updated_at: updatedAt,
      completion_state: collectionRun.completion_state,
      stop_reason: collectionRun.stop_reason,
      resume_supported: collectionRun.resume_supported
    };
  }

  function mergeCumulativeCatalog(existingCatalog, runBundle) {
    if (runBundle?.collector_version !== COLLECTOR_VERSION || runBundle?.export_kind !== "RUN") {
      throw new Error("RUN_EXPORT_CONTRACT_MISMATCH");
    }
    const validation = validateExportBundle(runBundle);
    if (!validation.valid) throw new Error(`RUN_EXPORT_INVALID:${validation.errors.join(",")}`);
    const run = runBundle.collection_run;
    if (!run || !sameCollectionScope(run.collection_scope, runBundle.collection_scope)) {
      throw new Error("RUN_SCOPE_CONTRACT_MISMATCH");
    }
    if (existingCatalog) {
      if (existingCatalog.cumulative_schema_version !== CUMULATIVE_SCHEMA_VERSION) {
        throw new Error("CUMULATIVE_SCHEMA_MISMATCH");
      }
      if (!sameCollectionScope(existingCatalog.collection_scope, run.collection_scope)) {
        throw new Error("CUMULATIVE_SCOPE_MISMATCH");
      }
    }

    const postMap = new Map((existingCatalog?.posts || []).map((post) => [post.post_uuid, post]));
    const creatorMap = new Map((existingCatalog?.creators || []).map((creator) => [creatorKey(creator), creator]));
    const postObservationMap = new Map(
      (existingCatalog?.post_observations || []).map((observation) => [observation.post_uuid, observation])
    );
    const creatorObservationMap = new Map(
      (existingCatalog?.creator_observations || []).map((observation) => [observation.creator_key, observation])
    );
    const mergeCounts = {
      posts_added: 0,
      posts_unchanged: 0,
      posts_updated: 0,
      creators_added: 0,
      creators_unchanged: 0,
      creators_updated: 0,
      conflicts: 0,
      deletion_candidates: 0
    };

    for (const observedPost of runBundle.posts || []) {
      const existingPost = postMap.get(observedPost.post_uuid);
      if (existingPost) {
        assertCompatiblePostIdentity(existingPost, observedPost);
        if (stableJson(comparableRecord(existingPost)) === stableJson(comparableRecord(observedPost))) {
          mergeCounts.posts_unchanged += 1;
        } else {
          postMap.set(observedPost.post_uuid, observedPost);
          mergeCounts.posts_updated += 1;
        }
      } else {
        if (!parsePostUrl(observedPost.post_public_url)) {
          throw new Error(`POST_IDENTITY_CONFLICT:${observedPost.post_uuid || "UNKNOWN"}`);
        }
        postMap.set(observedPost.post_uuid, observedPost);
        mergeCounts.posts_added += 1;
      }
      postObservationMap.set(
        observedPost.post_uuid,
        observationFor(
          observedPost,
          "post_uuid",
          run.run_id,
          postObservationMap.get(observedPost.post_uuid)
        )
      );
    }

    const observedCreators = [
      ...(runBundle.creators || []),
      ...(runBundle.posts || []).map(creatorFromPost).filter(Boolean)
    ];
    for (const observedCreator of observedCreators) {
      const key = creatorKey(observedCreator);
      if (!key) continue;
      const existingCreator = creatorMap.get(key);
      if (!existingCreator) {
        creatorMap.set(key, observedCreator);
        mergeCounts.creators_added += 1;
      } else {
        const mergedCreator = mergeCreatorRecord(existingCreator, observedCreator);
        if (stableJson(comparableRecord(existingCreator)) === stableJson(comparableRecord(mergedCreator))) {
          mergeCounts.creators_unchanged += 1;
        } else {
          creatorMap.set(key, mergedCreator);
          mergeCounts.creators_updated += 1;
        }
      }
      const recordForObservation = { ...observedCreator, creator_key: key };
      creatorObservationMap.set(
        key,
        observationFor(
          recordForObservation,
          "creator_key",
          run.run_id,
          creatorObservationMap.get(key)
        )
      );
    }

    const posts = [...postMap.values()].sort((left, right) => left.post_uuid.localeCompare(right.post_uuid));
    const creators = [...creatorMap.values()].sort((left, right) => creatorKey(left).localeCompare(creatorKey(right)));
    const updatedAt = runBundle.collected_at;
    const priorRuns = existingCatalog?.runs || [];
    const runSummary = {
      run_id: run.run_id,
      mode: run.mode,
      start_page: run.start_page,
      last_successfully_collected_page: run.last_successfully_collected_page,
      pages_collected: run.pages_collected_this_run,
      posts_observed: runBundle.posts.length,
      creators_observed: runBundle.creators.length,
      completion_state: run.completion_state,
      stop_reason: run.stop_reason,
      collected_at: run.collected_at
    };
    const existingRun = priorRuns.find((item) => item.run_id === run.run_id);
    if (existingRun && stableJson(existingRun) !== stableJson(runSummary)) throw new Error("RUN_ID_CONFLICT");
    const runs = existingRun ? [...priorRuns] : [...priorRuns, runSummary];
    const checkpoint = buildCheckpoint(run, posts, existingCatalog?.checkpoint_summary, updatedAt);
    const warnings = [...new Set([...(existingCatalog?.warnings || []), ...(runBundle.warnings || [])])];
    const pages = existingRun
      ? [...(existingCatalog?.pages || [])]
      : [...(existingCatalog?.pages || []), ...(runBundle.pages || [])];
    const catalog = {
      schema_version: SCHEMA_VERSION,
      cumulative_schema_version: CUMULATIVE_SCHEMA_VERSION,
      collector_version: COLLECTOR_VERSION,
      export_kind: "CUMULATIVE",
      source: runBundle.source,
      collection_scope: run.collection_scope,
      collected_at: updatedAt,
      first_collected_at: existingCatalog?.first_collected_at || runBundle.collected_at,
      last_collected_at: updatedAt,
      stop_reason: run.stop_reason,
      checkpoint_summary: checkpoint,
      run_count: runs.length,
      runs,
      pages,
      creators,
      posts,
      post_observations: [...postObservationMap.values()].sort((left, right) =>
        left.post_uuid.localeCompare(right.post_uuid)
      ),
      creator_observations: [...creatorObservationMap.values()].sort((left, right) =>
        left.creator_key.localeCompare(right.creator_key)
      ),
      merge_summary: mergeCounts,
      counts: {
        pages_scanned: pages.length,
        creators: creators.length,
        posts: posts.length,
        duplicate_creators_skipped: mergeCounts.creators_unchanged,
        duplicate_posts_skipped: mergeCounts.posts_unchanged,
        warnings: warnings.length
      },
      warnings
    };
    assertSafeExport(catalog);
    return { catalog, merge: mergeCounts };
  }

  function classifyIncrementalCatalog(catalog, existingState) {
    const existingPosts = new Map((existingState?.posts || []).map((post) => [post.post_uuid, post]));
    const existingCreators = new Map(
      (existingState?.creators || []).map((creator) => [creatorKey(creator), creator])
    );
    const result = {
      posts: { NEW: 0, EXISTING_IDENTICAL: 0, UPDATE_NEEDED: 0, CONFLICT: 0 },
      creators: { NEW: 0, EXISTING_IDENTICAL: 0, UPDATE_NEEDED: 0, CONFLICT: 0 },
      deletes: 0,
      unpublishes: 0
    };
    for (const post of catalog?.posts || []) {
      const existing = existingPosts.get(post.post_uuid);
      if (!existing) {
        result.posts.NEW += 1;
        continue;
      }
      try {
        assertCompatiblePostIdentity(existing, post);
        if (stableJson(comparableRecord(existing)) === stableJson(comparableRecord(post))) {
          result.posts.EXISTING_IDENTICAL += 1;
        } else {
          result.posts.UPDATE_NEEDED += 1;
        }
      } catch {
        result.posts.CONFLICT += 1;
      }
    }
    for (const creator of catalog?.creators || []) {
      const key = creatorKey(creator);
      if (!key) {
        result.creators.CONFLICT += 1;
        continue;
      }
      const existing = existingCreators.get(key);
      if (!existing) result.creators.NEW += 1;
      else if (stableJson(comparableRecord(existing)) === stableJson(comparableRecord(creator))) {
        result.creators.EXISTING_IDENTICAL += 1;
      } else result.creators.UPDATE_NEEDED += 1;
    }
    return result;
  }

  function creatorKey(creator) {
    if (creator.username) return `username:${String(creator.username).toLowerCase()}`;
    if (creator.profile_url) return `profile:${creator.profile_url}`;
    return null;
  }

  function fingerprintPage(snapshot) {
    const postIds = (snapshot.posts || []).map((post) => post.post_uuid).filter(Boolean).sort();
    const creatorIds = (snapshot.creators || []).map(creatorKey).filter(Boolean).sort();
    return stableHash(JSON.stringify([snapshot.source_surface, postIds, creatorIds]));
  }

  function assertSafeExport(value, path) {
    const currentPath = path || "$";
    if (Array.isArray(value)) {
      value.forEach((item, index) => assertSafeExport(item, `${currentPath}[${index}]`));
      return true;
    }
    if (!value || typeof value !== "object") return true;
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_EXPORT_KEY_RE.test(key)) throw new Error(`Forbidden export field at ${currentPath}.${key}`);
      assertSafeExport(child, `${currentPath}.${key}`);
    }
    return true;
  }

  function buildExport(pageSnapshots, options) {
    const pages = [];
    const posts = new Map();
    const creators = new Map();
    const warnings = [...(options?.warnings || [])];
    let duplicatePosts = 0;
    let duplicateCreators = 0;
    for (const snapshot of pageSnapshots || []) {
      const fingerprint = snapshot.fingerprint || fingerprintPage(snapshot);
      pages.push({
        source_surface: snapshot.source_surface,
        source_page_url: snapshot.source_page_url,
        collected_at: snapshot.collected_at,
        fingerprint,
        detected_posts: snapshot.posts?.length || 0,
        detected_creators: snapshot.creators?.length || 0,
        warnings: [...(snapshot.warnings || [])]
      });
      for (const post of snapshot.posts || []) {
        if (!post.post_uuid) continue;
        if (posts.has(post.post_uuid)) {
          duplicatePosts += 1;
          const existingPost = posts.get(post.post_uuid);
          assertCompatiblePostIdentity(existingPost, post);
          if (stableJson(comparableRecord(existingPost)) !== stableJson(comparableRecord(post))) {
            posts.set(post.post_uuid, post);
          }
        } else posts.set(post.post_uuid, post);
      }
      for (const creator of snapshot.creators || []) {
        const key = creatorKey(creator);
        if (!key) continue;
        if (creators.has(key)) {
          duplicateCreators += 1;
          creators.set(key, mergeCreatorRecord(creators.get(key), creator));
        } else creators.set(key, creator);
      }
      warnings.push(...(snapshot.warnings || []));
    }
    const bundle = {
      schema_version: SCHEMA_VERSION,
      collector_version: COLLECTOR_VERSION,
      source: {
        system: "MyFans Affiliate Center",
        mode: "RENDERED_UI_TEXT",
        host: AFFILIATE_HOST
      },
      collected_at: options?.collected_at || new Date().toISOString(),
      stop_reason: options?.stop_reason || null,
      pages,
      creators: [...creators.values()],
      posts: [...posts.values()],
      counts: {
        pages_scanned: pages.length,
        creators: creators.size,
        posts: posts.size,
        duplicate_creators_skipped: duplicateCreators,
        duplicate_posts_skipped: duplicatePosts,
        warnings: warnings.length
      },
      warnings: [...new Set(warnings)]
    };
    assertSafeExport(bundle);
    return bundle;
  }

  function validateExportBundle(bundle) {
    const errors = [];
    const warnings = [];
    try {
      assertSafeExport(bundle);
    } catch (error) {
      errors.push(error.message);
    }
    if (bundle?.schema_version !== SCHEMA_VERSION) errors.push("SCHEMA_VERSION_MISMATCH");
    if (bundle?.source?.mode !== "RENDERED_UI_TEXT") errors.push("SOURCE_MODE_MISMATCH");
    const seenPosts = new Set();
    for (const post of bundle?.posts || []) {
      if (!parsePostUrl(post.post_public_url) || post.post_uuid !== parsePostUrl(post.post_public_url)?.post_uuid) {
        errors.push("INVALID_POST_IDENTITY");
      }
      if (seenPosts.has(post.post_uuid)) errors.push("DUPLICATE_POST_UUID");
      seenPosts.add(post.post_uuid);
      if (post.relative_published_text && post.published_at) errors.push("RELATIVE_TIME_MUST_NOT_SET_PUBLISHED_AT");
    }
    const seenCreators = new Set();
    for (const creator of bundle?.creators || []) {
      const key = creatorKey(creator);
      if (!key) errors.push("CREATOR_IDENTITY_MISSING");
      else if (seenCreators.has(key)) errors.push("DUPLICATE_CREATOR_IDENTITY");
      else seenCreators.add(key);
      if ((creator.plans || []).some((plan) => !plan.plan_name)) warnings.push("PLAN_WITHOUT_STABLE_NAME");
    }
    return { valid: errors.length === 0, errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
  }

  function buildPrivateStagingPlan(bundle) {
    const validation = validateExportBundle(bundle);
    if (!validation.valid) return { apply: false, validation, targets: {} };
    const creatorRows = (bundle.creators || []).map((creator) => ({
      external_id: creator.username ? `username:${creator.username.toLowerCase()}` : `profile:${creator.profile_url}`,
      username: creator.username,
      name: creator.creator_name,
      profile_url: creator.profile_url,
      likes: creator.likes,
      followers: creator.followers,
      following: creator.following,
      post_count: creator.post_count,
      affiliate_enabled_post_count: creator.affiliate_enabled_post_count,
      single_reward_rate: creator.single_reward_rate,
      plan_initial_reward_rate: creator.plan_initial_reward_rate,
      plan_continuation_reward_rate: creator.plan_continuation_reward_rate,
      profile_image_url: null,
      source_type: "OFFICIAL_AUTH_UI",
      permission_scope: "AFFILIATE_VISIBLE"
    }));
    const postRows = (bundle.posts || []).map((post) => ({
      external_id: post.post_uuid,
      public_url: post.post_public_url,
      title: post.title,
      creator_external_id: post.creator_username ? `username:${post.creator_username.toLowerCase()}` : null,
      price_jpy: post.price_jpy,
      affiliate_reward_rate: post.affiliate_reward_rate,
      estimated_reward_jpy: post.estimated_reward_jpy,
      media_type: post.media_type,
      duration_seconds: post.video_duration_seconds,
      likes: post.likes,
      published_at: null,
      thumbnail_url: null,
      affiliate_enabled: true,
      source_type: "OFFICIAL_AUTH_UI",
      permission_scope: "AFFILIATE_VISIBLE"
    }));
    const planCandidates = (bundle.creators || []).flatMap((creator) =>
      (creator.plans || []).map((plan) => ({
        creator_external_id: creator.username ? `username:${creator.username.toLowerCase()}` : null,
        ...plan,
        import_status: "NEEDS_STABLE_PLAN_ID"
      }))
    );
    return {
      apply: false,
      validation,
      targets: {
        myfans_creators: creatorRows,
        myfans_posts: postRows,
        myfans_plans: [],
        myfans_post_plans: []
      },
      unresolved_plan_candidates: planCandidates,
      image_policy: "TEXT_ONLY_NULL_IMAGES",
      note: "Design-only target-scoped staging plan. No database operation is implemented."
    };
  }

  function hasExpectedCatalogRecords(snapshot, previousSnapshot) {
    if ((previousSnapshot.posts || []).length > 0) return (snapshot.posts || []).length > 0;
    if ((previousSnapshot.creators || []).length > 0) return (snapshot.creators || []).length > 0;
    return (snapshot.posts || []).length > 0 || (snapshot.creators || []).length > 0;
  }

  async function waitForDistinctPage(options) {
    const timeoutMs = Math.max(0, Number(options.timeout_ms) || 10000);
    const pollIntervalMs = Math.max(1, Number(options.poll_interval_ms) || 250);
    const now = options.now || (() => Date.now());
    const sleep = options.sleep || ((milliseconds) => new Promise((resolve) => global.setTimeout(resolve, milliseconds)));
    const startedAt = now();
    let sawChangedUrl = false;
    let sawDuplicateWithRecords = false;

    while (true) {
      const snapshot = await options.collect_current();
      snapshot.fingerprint = snapshot.fingerprint || fingerprintPage(snapshot);
      if (snapshot.stop_reason) {
        return {
          status: "SAFETY_STOP",
          reason: snapshot.stop_reason,
          snapshot
        };
      }

      const urlChanged = snapshot.source_page_url !== options.previous_url;
      if (urlChanged) {
        sawChangedUrl = true;
        if (hasExpectedCatalogRecords(snapshot, options.previous_snapshot)) {
          if (snapshot.fingerprint !== options.previous_fingerprint) {
            return { status: "READY", reason: null, snapshot };
          }
          sawDuplicateWithRecords = true;
        }
      }

      const elapsed = now() - startedAt;
      if (elapsed >= timeoutMs) break;
      await sleep(Math.min(pollIntervalMs, timeoutMs - elapsed));
    }

    return {
      status: "TIMEOUT",
      reason: sawChangedUrl && sawDuplicateWithRecords
        ? "DUPLICATE_PAGE_FINGERPRINT"
        : "PAGE_TRANSITION_TIMEOUT",
      snapshot: null
    };
  }

  function isMessageChannelClosedError(error) {
    const message = normalizeSpace(error?.message || error);
    return /(?:message channel closed|port closed|receiving end does not exist|could not establish connection)/i.test(message);
  }

  function operationError(operationId, stage, code, cause) {
    const normalizedOperationId = normalizeSpace(operationId) || "operation-unknown";
    const normalizedStage = OPERATION_STAGES[stage] || stage || "UNKNOWN_STAGE";
    const normalizedCode = normalizeSpace(code) || "OPERATION_FAILED";
    const error = new Error(`[${normalizedOperationId}][${normalizedStage}] ${normalizedCode}`);
    error.operation_id = normalizedOperationId;
    error.operation_stage = normalizedStage;
    error.code = normalizedCode;
    if (cause) error.cause = cause;
    return error;
  }

  async function stageCall(operationId, stage, task, fallbackCode) {
    try {
      return await task();
    } catch (error) {
      if (error?.operation_id && error?.operation_stage && error?.code) throw error;
      const code = isMessageChannelClosedError(error)
        ? "CHANNEL_CLOSED_BEFORE_ACK"
        : fallbackCode || normalizeSpace(error?.message) || "OPERATION_FAILED";
      throw operationError(operationId, stage, code, error);
    }
  }

  function validateNavigationAck(ack, operationId, stage, previousSnapshot) {
    if (!ack || ack.ok !== true || ack.operation_id !== operationId || ack.operation_stage !== stage) {
      throw operationError(operationId, stage, "INVALID_NAVIGATION_ACK");
    }
    const previousContext = collectionContextFromUrl(previousSnapshot?.source_page_url);
    if (!previousContext || ack.from_page !== previousContext.page) {
      throw operationError(operationId, stage, "NAVIGATION_ACK_FROM_PAGE_MISMATCH");
    }
    if (ack.previous_fingerprint !== previousSnapshot.fingerprint) {
      throw operationError(operationId, stage, "NAVIGATION_ACK_FINGERPRINT_MISMATCH");
    }
    if (ack.navigation_expected) {
      if (!Number.isSafeInteger(ack.expected_next_page) || ack.expected_next_page <= ack.from_page) {
        throw operationError(operationId, stage, "NAVIGATION_ACK_NEXT_PAGE_INVALID");
      }
    } else if (ack.expected_next_page !== null) {
      throw operationError(operationId, stage, "NAVIGATION_ACK_COMPLETION_INVALID");
    }
    return ack;
  }

  async function waitForNavigationReady(options) {
    const operationId = options.operation_id;
    const ack = options.ack;
    if (!options.ack_delivered || !ack?.navigation_expected) {
      throw operationError(operationId, OPERATION_STAGES.WAIT_NEW_DOCUMENT, "NAVIGATION_ACK_REQUIRED");
    }
    const previousSnapshot = options.previous_snapshot;
    const previousFingerprint = previousSnapshot.fingerprint || fingerprintPage(previousSnapshot);
    const previousContext = collectionContextFromUrl(previousSnapshot.source_page_url);
    if (!previousContext) {
      throw operationError(operationId, OPERATION_STAGES.VALIDATE_NEXT_PAGE, "PREVIOUS_PAGE_CONTEXT_INVALID");
    }
    const timeoutMs = Math.max(0, Number(options.timeout_ms) || 10000);
    const pollIntervalMs = Math.max(1, Number(options.poll_interval_ms) || 250);
    const now = options.now || (() => Date.now());
    const sleep = options.sleep || ((milliseconds) => new Promise((resolve) => global.setTimeout(resolve, milliseconds)));
    const startedAt = now();
    let sawExpectedPage = false;
    let sawExpectedPageWithRows = false;
    let sawExpectedPageWithOldFingerprint = false;

    while (true) {
      let snapshot = null;
      try {
        snapshot = await options.collect_current();
      } catch (error) {
        if (!isMessageChannelClosedError(error)) {
          throw operationError(
            operationId,
            OPERATION_STAGES.WAIT_NEW_DOCUMENT,
            normalizeSpace(error?.message) || "NEW_DOCUMENT_NOT_REACHABLE",
            error
          );
        }
      }

      if (snapshot) {
        snapshot.fingerprint = snapshot.fingerprint || fingerprintPage(snapshot);
        if (snapshot.stop_reason) {
          throw operationError(operationId, OPERATION_STAGES.VALIDATE_NEXT_PAGE, snapshot.stop_reason);
        }
        const context = collectionContextFromUrl(snapshot.source_page_url);
        if (!context) {
          throw operationError(operationId, OPERATION_STAGES.VALIDATE_NEXT_PAGE, "NEXT_PAGE_CONTEXT_INVALID");
        }
        if (context.collection_scope.key !== options.expected_scope_key) {
          throw operationError(operationId, OPERATION_STAGES.VALIDATE_NEXT_PAGE, "COLLECTION_SCOPE_MISMATCH");
        }
        if (context.page !== ack.expected_next_page) {
          if (context.page !== ack.from_page) {
            throw operationError(operationId, OPERATION_STAGES.VALIDATE_NEXT_PAGE, "EXPECTED_PAGE_MISMATCH");
          }
        } else {
          sawExpectedPage = true;
          const hasRows = hasExpectedCatalogRecords(snapshot, previousSnapshot);
          if (hasRows) {
            sawExpectedPageWithRows = true;
            if (snapshot.fingerprint !== previousFingerprint) return snapshot;
            sawExpectedPageWithOldFingerprint = true;
          }
        }
      }

      const elapsed = now() - startedAt;
      if (elapsed >= timeoutMs) break;
      await sleep(Math.min(pollIntervalMs, timeoutMs - elapsed));
    }

    if (sawExpectedPageWithOldFingerprint) {
      throw operationError(operationId, OPERATION_STAGES.VALIDATE_NEXT_PAGE, "PAGE_FINGERPRINT_UNCHANGED");
    }
    if (sawExpectedPage && !sawExpectedPageWithRows) {
      throw operationError(operationId, OPERATION_STAGES.VALIDATE_NEXT_PAGE, "CATALOG_ROWS_NOT_READY");
    }
    throw operationError(operationId, OPERATION_STAGES.WAIT_NEW_DOCUMENT, "NEW_DOCUMENT_TIMEOUT");
  }

  function validateCollectedPage(snapshot, options) {
    if (!snapshot || typeof snapshot !== "object") {
      throw operationError(options.operation_id, OPERATION_STAGES.COLLECT_PAGE, "PAGE_SNAPSHOT_MISSING");
    }
    snapshot.fingerprint = snapshot.fingerprint || fingerprintPage(snapshot);
    if (snapshot.stop_reason) {
      throw operationError(options.operation_id, OPERATION_STAGES.COLLECT_PAGE, snapshot.stop_reason);
    }
    const context = collectionContextFromUrl(snapshot.source_page_url);
    if (!context) {
      throw operationError(options.operation_id, OPERATION_STAGES.COLLECT_PAGE, "PAGE_CONTEXT_INVALID");
    }
    if (context.collection_scope.key !== options.expected_scope_key) {
      throw operationError(options.operation_id, OPERATION_STAGES.COLLECT_PAGE, "COLLECTION_SCOPE_MISMATCH");
    }
    if (options.expected_page != null && context.page !== options.expected_page) {
      throw operationError(options.operation_id, OPERATION_STAGES.COLLECT_PAGE, "COLLECTION_START_PAGE_MISMATCH");
    }
    if ((snapshot.posts || []).length === 0 && (snapshot.creators || []).length === 0) {
      throw operationError(options.operation_id, OPERATION_STAGES.COLLECT_PAGE, "NO_CATALOG_RECORDS_DETECTED");
    }
    return { snapshot, context };
  }

  async function runNavigationStateMachine(options) {
    const operationId = normalizeSpace(options.operation_id);
    if (!operationId) throw operationError("operation-unknown", OPERATION_STAGES.COLLECT_PAGE, "OPERATION_ID_REQUIRED");
    const maxPages = Math.max(1, Math.min(MAX_RUN_PAGES, Number(options.max_pages) || MAX_RUN_PAGES));
    const pages = [];
    const fingerprints = new Set();
    let pendingSnapshot = options.initial_snapshot || null;
    let expectedPage = options.expected_start_page ?? null;

    if (options.resume_from_snapshot) {
      const previous = validateCollectedPage(options.resume_from_snapshot, {
        operation_id: operationId,
        expected_scope_key: options.expected_scope_key,
        expected_page: options.resume_from_page
      }).snapshot;
      const ack = validateNavigationAck(
        await stageCall(
          operationId,
          OPERATION_STAGES.PREPARE_RESUME,
          () => options.prepare_navigation({
            operation_id: operationId,
            operation_stage: OPERATION_STAGES.PREPARE_RESUME,
            previous_snapshot: previous
          }),
          "PREPARE_RESUME_FAILED"
        ),
        operationId,
        OPERATION_STAGES.PREPARE_RESUME,
        previous
      );
      if (!ack.navigation_expected) {
        throw operationError(operationId, OPERATION_STAGES.PREPARE_RESUME, "RESUME_NEXT_CONTROL_NOT_AVAILABLE");
      }
      pendingSnapshot = await stageCall(
        operationId,
        OPERATION_STAGES.WAIT_NEW_DOCUMENT,
        () => options.wait_for_ready({ ack, previous_snapshot: previous, ack_delivered: true }),
        "WAIT_NEW_DOCUMENT_FAILED"
      );
      expectedPage = ack.expected_next_page;
    }

    let stopReason = "NEXT_CONTROL_ABSENT_OR_DISABLED";
    let finalNextControl = { present: false, enabled: false, href: null };
    while (pages.length < maxPages) {
      const candidate = pendingSnapshot || await stageCall(
        operationId,
        OPERATION_STAGES.COLLECT_PAGE,
        () => options.collect_current(),
        "COLLECT_PAGE_FAILED"
      );
      pendingSnapshot = null;
      const validated = validateCollectedPage(candidate, {
        operation_id: operationId,
        expected_scope_key: options.expected_scope_key,
        expected_page: expectedPage
      });
      expectedPage = null;
      if (fingerprints.has(validated.snapshot.fingerprint)) {
        throw operationError(operationId, OPERATION_STAGES.COLLECT_PAGE, "DUPLICATE_PAGE_FINGERPRINT");
      }
      fingerprints.add(validated.snapshot.fingerprint);
      pages.push(validated.snapshot);

      if (pages.length >= maxPages) {
        finalNextControl = await stageCall(
          operationId,
          OPERATION_STAGES.VALIDATE_NEXT_PAGE,
          () => options.inspect_next({
            operation_id: operationId,
            expected_scope_key: options.expected_scope_key,
            expected_page: validated.context.page,
            expected_fingerprint: validated.snapshot.fingerprint
          }),
          "INSPECT_NEXT_FAILED"
        );
        stopReason = finalNextControl?.present && finalNextControl?.enabled
          ? "MAX_PAGE_LIMIT_REACHED"
          : "NEXT_CONTROL_ABSENT_OR_DISABLED";
        break;
      }

      const ack = validateNavigationAck(
        await stageCall(
          operationId,
          OPERATION_STAGES.PREPARE_NEXT,
          () => options.prepare_navigation({
            operation_id: operationId,
            operation_stage: OPERATION_STAGES.PREPARE_NEXT,
            previous_snapshot: validated.snapshot
          }),
          "PREPARE_NEXT_FAILED"
        ),
        operationId,
        OPERATION_STAGES.PREPARE_NEXT,
        validated.snapshot
      );
      if (!ack.navigation_expected) {
        finalNextControl = { present: false, enabled: false, href: null };
        stopReason = "NEXT_CONTROL_ABSENT_OR_DISABLED";
        break;
      }
      pendingSnapshot = await stageCall(
        operationId,
        OPERATION_STAGES.WAIT_NEW_DOCUMENT,
        () => options.wait_for_ready({ ack, previous_snapshot: validated.snapshot, ack_delivered: true }),
        "WAIT_NEW_DOCUMENT_FAILED"
      );
      expectedPage = ack.expected_next_page;
    }

    return {
      operation_id: operationId,
      page_snapshots: pages,
      stop_reason: stopReason,
      next_control: finalNextControl,
      pages_collected: pages.length
    };
  }

  async function executeNavigationSafeRun(options) {
    const operationId = options.operation_id;
    const navigationResult = await runNavigationStateMachine(options);
    return stageCall(
      operationId,
      OPERATION_STAGES.COMMIT_RUN,
      () => options.commit_run(navigationResult),
      "COMMIT_RUN_FAILED"
    );
  }

  async function runPagination(options) {
    const maxPages = Math.max(1, Math.min(MAX_RUN_PAGES, Number(options.max_pages) || MAX_RUN_PAGES));
    const pages = [];
    const seen = new Set();
    const warnings = [];
    let stopReason = "NEXT_CONTROL_ABSENT_OR_DISABLED";
    let pendingSnapshot = null;
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const snapshot = pendingSnapshot || await options.collect_current();
      pendingSnapshot = null;
      if (snapshot.stop_reason) {
        warnings.push(`SAFETY_STOP:${snapshot.stop_reason}`);
        stopReason = snapshot.stop_reason;
        break;
      }
      const fingerprint = snapshot.fingerprint || fingerprintPage(snapshot);
      snapshot.fingerprint = fingerprint;
      if (seen.has(fingerprint)) {
        warnings.push("DUPLICATE_PAGE_FINGERPRINT");
        stopReason = "DUPLICATE_PAGE_FINGERPRINT";
        break;
      }
      seen.add(fingerprint);
      pages.push(snapshot);
      if (pages.length >= maxPages) {
        const control = await options.get_next_control();
        stopReason = control ? "MAX_PAGE_LIMIT_REACHED" : "NEXT_CONTROL_ABSENT_OR_DISABLED";
        break;
      }
      const control = await options.get_next_control();
      if (!control) {
        stopReason = "NEXT_CONTROL_ABSENT_OR_DISABLED";
        break;
      }
      await options.activate_next(control);
      const transition = await options.wait_for_page_change(fingerprint, snapshot.source_page_url, snapshot);
      if (!transition) {
        warnings.push("PAGE_TRANSITION_TIMEOUT");
        stopReason = "PAGE_TRANSITION_TIMEOUT";
        break;
      }
      if (transition.status === "READY" && transition.snapshot) {
        pendingSnapshot = transition.snapshot;
        continue;
      }
      const reason = transition.reason || "PAGE_TRANSITION_TIMEOUT";
      warnings.push(transition.status === "SAFETY_STOP" ? `SAFETY_STOP:${reason}` : reason);
      stopReason = reason;
      break;
    }
    return buildExport(pages, {
      collected_at: options.collected_at || new Date().toISOString(),
      stop_reason: stopReason,
      warnings
    });
  }

  global.MyFansCollectorCore = Object.freeze({
    AFFILIATE_HOST,
    CHECKPOINT_SCHEMA_VERSION,
    COLLECTOR_VERSION,
    CUMULATIVE_SCHEMA_VERSION,
    MAX_RUN_PAGES,
    OPERATION_STAGES,
    SCHEMA_VERSION,
    assertSafeExport,
    attachCollectionRunMetadata,
    buildExport,
    buildPrivateStagingPlan,
    canonicalCollectionScope,
    classifyIncrementalCatalog,
    cleanCreatorName,
    collectionContextFromUrl,
    creatorKey,
    detectStopCondition,
    executeNavigationSafeRun,
    extractCreatorFromDescriptor,
    extractPlanFromDescriptor,
    extractPostFromDescriptor,
    fingerprintPage,
    hrefPattern,
    isMessageChannelClosedError,
    isAllowedPageUrl,
    makeProbeSummary,
    normalizeSpace,
    parseCreatorProfileUrl,
    parseAffiliateCreatorRoute,
    parseDisplayedAffiliateUrl,
    parseDuration,
    parseEstimatedReward,
    parseInteger,
    parseLikes,
    parseLabeledNumber,
    parseLabeledRate,
    parseLabeledYen,
    parsePostUrl,
    parseRelativePublishedText,
    pageNumberFromUrl,
    mergeCumulativeCatalog,
    operationError,
    runNavigationStateMachine,
    runPagination,
    scorePostCardContainerCandidate,
    selectPostCardContainerCandidate,
    sourceSurfaceFromUrl,
    stableHash,
    summarizePostTitleSegmentWindow,
    validateResumeCheckpoint,
    validateExportBundle,
    waitForNavigationReady,
    waitForDistinctPage
  });
})(globalThis);
