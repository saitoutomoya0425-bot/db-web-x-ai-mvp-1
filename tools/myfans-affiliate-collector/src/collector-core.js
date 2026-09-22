(function installMyFansCollectorCore(global) {
  "use strict";

  const COLLECTOR_VERSION = "0.1.0";
  const SCHEMA_VERSION = "myfans-affiliate-catalog-local-v1";
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

  function firstMeaningfulTitle(candidates) {
    const blocked = /^(?:@|次へ$|コピー$|投稿のアフィURL$|プロフィールURL$|\d{1,2}:\d{2}(?::\d{2})?$)/;
    for (const candidate of candidates || []) {
      const value = normalizeSpace(candidate);
      if (value.length >= 2 && value.length <= 300 && !blocked.test(value)) return value;
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
    const title = firstMeaningfulTitle(descriptor.title_candidates || [descriptor.anchor_text]);
    const creatorName = firstMeaningfulTitle(descriptor.creator_name_candidates || []);
    const username = profile?.username || affiliateCreatorRoute?.username || parseUsernameFromText(text);
    const displayedAffiliateUrl = links.map((link) => parseDisplayedAffiliateUrl(link.href)).find(Boolean) || null;
    const price = parseLabeledYen(text, ["単品販売価格", "販売価格", "単品販売", "価格"]);
    const estimatedReward = parseLabeledYen(text, ["推定報酬", "見込報酬", "報酬額", "報酬"]);
    const rewardRate = parseLabeledRate(text, ["アフィリエイト報酬率", "報酬率", "報酬単価"]);
    const likes = parseLabeledNumber(text, ["いいね"]);
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
      parser_confidence: confidenceFromEvidence(
        [identity.post_uuid, descriptor.source_surface],
        [title, creatorName || username, price !== null, rewardRate !== null]
      )
    };
    if (displayedAffiliateUrl) record.displayed_affiliate_url = displayedAffiliateUrl;
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
    const creatorName = firstMeaningfulTitle(descriptor.name_candidates || []);
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
        if (posts.has(post.post_uuid)) duplicatePosts += 1;
        else posts.set(post.post_uuid, post);
      }
      for (const creator of snapshot.creators || []) {
        const key = creatorKey(creator);
        if (!key) continue;
        if (creators.has(key)) duplicateCreators += 1;
        else creators.set(key, creator);
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

  async function runPagination(options) {
    const maxPages = Math.max(1, Math.min(5, Number(options.max_pages) || 5));
    const pages = [];
    const seen = new Set();
    const warnings = [];
    let stopReason = "NEXT_CONTROL_ABSENT_OR_DISABLED";
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const snapshot = await options.collect_current();
      const fingerprint = snapshot.fingerprint || fingerprintPage(snapshot);
      snapshot.fingerprint = fingerprint;
      if (seen.has(fingerprint)) {
        warnings.push("DUPLICATE_PAGE_FINGERPRINT");
        stopReason = "DUPLICATE_PAGE_FINGERPRINT";
        break;
      }
      seen.add(fingerprint);
      pages.push(snapshot);
      if (snapshot.stop_reason) {
        stopReason = snapshot.stop_reason;
        break;
      }
      if (pages.length >= maxPages) {
        stopReason = "MAX_PAGE_LIMIT_REACHED";
        break;
      }
      const control = await options.get_next_control();
      if (!control) {
        stopReason = "NEXT_CONTROL_ABSENT_OR_DISABLED";
        break;
      }
      await options.activate_next(control);
      const changed = await options.wait_for_page_change(fingerprint, snapshot.source_page_url);
      if (!changed) {
        warnings.push("PAGE_CHANGE_TIMEOUT");
        stopReason = "PAGE_CHANGE_TIMEOUT";
        break;
      }
    }
    return buildExport(pages, {
      collected_at: options.collected_at || new Date().toISOString(),
      stop_reason: stopReason,
      warnings
    });
  }

  global.MyFansCollectorCore = Object.freeze({
    AFFILIATE_HOST,
    COLLECTOR_VERSION,
    SCHEMA_VERSION,
    assertSafeExport,
    buildExport,
    buildPrivateStagingPlan,
    creatorKey,
    detectStopCondition,
    extractCreatorFromDescriptor,
    extractPlanFromDescriptor,
    extractPostFromDescriptor,
    fingerprintPage,
    hrefPattern,
    isAllowedPageUrl,
    makeProbeSummary,
    normalizeSpace,
    parseCreatorProfileUrl,
    parseAffiliateCreatorRoute,
    parseDisplayedAffiliateUrl,
    parseDuration,
    parseInteger,
    parseLabeledNumber,
    parseLabeledRate,
    parseLabeledYen,
    parsePostUrl,
    parseRelativePublishedText,
    runPagination,
    sourceSurfaceFromUrl,
    stableHash,
    validateExportBundle
  });
})(globalThis);
