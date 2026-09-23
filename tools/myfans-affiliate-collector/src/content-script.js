(function installMyFansCollectorContentScript() {
  "use strict";

  const core = globalThis.MyFansCollectorCore;
  if (!core || globalThis.__MYFANS_LOCAL_COLLECTOR_INSTALLED__) return;
  globalThis.__MYFANS_LOCAL_COLLECTOR_INSTALLED__ = true;

  const SAFE_QUERY_KEYS = new Set([
    "genre_id",
    "genre_name",
    "keyword",
    "media_type",
    "page",
    "q",
    "query",
    "sexual_orientation",
    "sort"
  ]);

  function safeSourcePageUrl(value) {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (!SAFE_QUERY_KEYS.has(key)) url.searchParams.delete(key);
    }
    url.hash = "";
    return url.href;
  }

  function anonymousProbePageUrl(value) {
    const url = new URL(safeSourcePageUrl(value));
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, "REDACTED");
    return url.href;
  }

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const style = globalThis.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    return element.getClientRects().length > 0;
  }

  function visibleText(element) {
    if (!(element instanceof Element) || !isVisible(element)) return "";
    return core.normalizeSpace(element.innerText || element.textContent || "");
  }

  function allVisible(root, selector) {
    return [...root.querySelectorAll(selector)].filter(isVisible);
  }

  function closestSemanticContainer(anchor) {
    let current = anchor;
    let fallback = anchor.parentElement;
    for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
      if (!(current instanceof Element)) continue;
      if (current.matches("main, body")) break;
      if (current.matches("article, li, [role='listitem']")) return current;
      const textLength = visibleText(current).length;
      const postLinkCount = current.querySelectorAll?.("a[href*='myfans.jp/posts/']").length || 0;
      if (textLength >= 12 && textLength <= 3500 && postLinkCount <= 1) {
        if (!fallback) fallback = current;
        if (/(?:価格|報酬|いいね|フォロワー|投稿数|月額)/.test(visibleText(current))) return current;
      }
    }
    return fallback || anchor;
  }

  function orderedVisibleSegmentCandidates(element) {
    if (!(element instanceof Element) || !isVisible(element)) return [];
    return String(element.innerText || element.textContent || "")
      .split(/[\r\n]+/)
      .map(core.normalizeSpace)
      .filter(Boolean)
      .slice(0, 240)
      .map((text, index) => ({
        text,
        strategy: "CARD_ORDERED_SEGMENT_WINDOW",
        segment_order: index + 1
      }));
  }

  function diagnosticVisibleSegmentCandidates(element) {
    if (!(element instanceof Element) || !isVisible(element)) return [];
    return String(element.innerText || "")
      .split(/[\r\n]+/)
      .map(core.normalizeSpace)
      .filter(Boolean)
      .slice(0, 30)
      .map((text, index) => ({
        text,
        strategy: "CARD_ORDERED_SEGMENT_WINDOW",
        segment_order: index + 1
      }));
  }

  function postCardCandidateEvidence(element, targetPostUuid, depth) {
    const anchors = [
      ...(element.matches("a[href]") && isVisible(element) ? [element] : []),
      ...allVisible(element, "a[href]")
    ];
    const postUuids = new Set(
      anchors
        .map((candidate) => core.parsePostUrl(candidate.href)?.post_uuid)
        .filter(Boolean)
    );
    const creatorLinkEntries = anchors
      .map((candidate) => ({
        identity:
          core.parseCreatorProfileUrl(candidate.href) ||
          core.parseAffiliateCreatorRoute(candidate.href),
        text: visibleText(candidate)
      }))
      .filter((entry) => entry.identity);
    const creatorCandidates = creatorLinkEntries
      .flatMap((entry) => [entry.text, core.cleanCreatorName(entry.text)])
      .filter((text) => text && !text.startsWith("@"));
    const creatorExclusions = [
      ...creatorCandidates,
      ...creatorLinkEntries.flatMap((entry) => [
        entry.identity.username,
        entry.identity.username ? "@" + entry.identity.username : null
      ])
    ].filter(Boolean);
    const text = visibleText(element);
    const canBeSingleCard = postUuids.size === 1 && text.length <= 8000;
    const segments = canBeSingleCard ? orderedVisibleSegmentCandidates(element) : [];
    const leafCandidates = canBeSingleCard
      ? orderedVisibleLeafTitleData(element).candidates
      : [];
    const segmentWindow = core.summarizePostTitleSegmentWindow(segments, creatorExclusions);
    const leafWindow = core.summarizePostTitleSegmentWindow(leafCandidates, creatorExclusions);
    const safeTitleCandidateCount = Math.max(
      segmentWindow.safe_candidate_count,
      leafWindow.safe_candidate_count
    );
    const categorySignalCount = [
      "見た目",
      "プレイ",
      "タイプ",
      "シチュエーション",
      "コスチューム"
    ].filter((label) => text.includes(label)).length;
    const hasAffiliateCopyAction =
      /(?:投稿|作品)(?:の)?アフィ(?:リエイト)?URL(?:の|を)?コピー/.test(text);
    return {
      depth,
      contains_target_post: postUuids.has(targetPostUuid),
      post_link_count: postUuids.size,
      text_length: text.length,
      has_price_signal: /(?:単品販売価格|販売価格)/.test(text),
      has_reward_signal: /(?:アフィ(?:リエイト)?報酬率|報酬率|報酬額)/.test(text),
      has_affiliate_copy_action: hasAffiliateCopyAction,
      has_profile_action: /プロフィールURL/.test(text),
      has_creator_signal: creatorLinkEntries.length > 0 || creatorCandidates.length > 0,
      has_relative_date_signal: Boolean(core.parseRelativePublishedText(text)),
      has_duration_signal: Boolean(core.parseDuration(text)),
      has_post_action:
        hasAffiliateCopyAction ||
        /(?:投稿|作品)(?:を見る|を開く|詳細)/.test(text),
      title_window_candidate_count: safeTitleCandidateCount,
      safe_title_candidate_count: safeTitleCandidateCount,
      ordered_segment_count: segments.length,
      has_page_navigation:
        element.matches("nav, [role='navigation']") ||
        Boolean(element.querySelector("nav, [role='navigation']")) ||
        (/ホーム/.test(text) && /アフィ検索/.test(text) && /レポート/.test(text)),
      has_category_ui: categorySignalCount >= 3,
      is_page_level: element.matches("main, body")
    };
  }

  function selectPostCardContainer(anchor) {
    const identity = core.parsePostUrl(anchor.href);
    const candidates = [];
    let current = anchor;
    for (let depth = 0; current && depth < 10; depth += 1, current = current.parentElement) {
      if (!(current instanceof Element)) continue;
      if (current.matches("main, body")) break;
      candidates.push({
        element: current,
        evidence: postCardCandidateEvidence(current, identity.post_uuid, depth)
      });
    }
    const selection = core.selectPostCardContainerCandidate(
      candidates.map((candidate) => candidate.evidence)
    );
    const ancestorCandidates = candidates.map((candidate) => ({
      ...candidate,
      scoring: core.scorePostCardContainerCandidate(candidate.evidence)
    }));
    if (!selection) {
      return {
        container: anchor.parentElement || anchor,
        evidence: {
          depth: 0,
          selected_container_score: 0,
          post_link_count: 1,
          has_price_signal: false,
          has_reward_signal: false,
          has_affiliate_copy_action: false,
          has_creator_signal: false
        },
        ancestor_candidates: ancestorCandidates
      };
    }
    return {
      container: candidates[selection.candidate_index].element,
      evidence: selection,
      ancestor_candidates: ancestorCandidates
    };
  }

  function titleExclusionsForContainer(container) {
    const entries = linkDescriptors(container)
      .map((link) => ({
        identity:
          core.parseCreatorProfileUrl(link.href) ||
          core.parseAffiliateCreatorRoute(link.href),
        text: link.text
      }))
      .filter((entry) => entry.identity);
    return [
      ...entries.flatMap((entry) => [entry.text, core.cleanCreatorName(entry.text)]),
      ...entries.flatMap((entry) => [
        entry.identity.username,
        entry.identity.username ? `@${entry.identity.username}` : null
      ])
    ].filter(Boolean);
  }

  function missingTitleAncestorContext(cardSelection) {
    const selectedDepth = cardSelection.evidence.depth;
    const eligibleCandidates = (cardSelection.ancestor_candidates || [])
      .filter((candidate) => candidate.scoring.eligible);
    const eligibleAncestors = eligibleCandidates.map((candidate) => ({
      depth: candidate.evidence.depth,
      score: candidate.scoring.score,
      post_link_count: candidate.evidence.post_link_count,
      safe_title_candidate_count: candidate.evidence.safe_title_candidate_count,
      ordered_segment_count: candidate.evidence.ordered_segment_count,
      has_price_signal: candidate.evidence.has_price_signal,
      has_reward_signal: candidate.evidence.has_reward_signal,
      has_creator_signal: candidate.evidence.has_creator_signal,
      has_affiliate_copy_action: candidate.evidence.has_affiliate_copy_action
    }));
    const visibleSegmentAncestors = eligibleCandidates
      .filter((candidate) =>
        candidate.evidence.depth === selectedDepth ||
        (
          candidate.evidence.depth > selectedDepth &&
          candidate.evidence.depth <= selectedDepth + 2
        )
      )
      .slice(0, 3)
      .map((candidate) => ({
        depth: candidate.evidence.depth,
        selected: candidate.evidence.depth === selectedDepth,
        segments: diagnosticVisibleSegmentCandidates(candidate.element),
        excluded_candidates: titleExclusionsForContainer(candidate.element)
      }));
    return {
      eligible_ancestors: eligibleAncestors,
      visible_segment_ancestors: visibleSegmentAncestors
    };
  }

  function linkDescriptors(container) {
    return allVisible(container, "a[href]").map((anchor) => ({
      href: anchor.href,
      text: visibleText(anchor),
      visible: true
    }));
  }

  function headingCandidates(container) {
    return allVisible(container, "h1, h2, h3, h4, h5, h6, [role='heading']")
      .map(visibleText)
      .filter(Boolean);
  }

  function directText(element) {
    if (!(element instanceof Element) || !isVisible(element)) return "";
    return core.normalizeSpace(
      [...element.childNodes]
        .filter((node) => node.nodeType === 3)
        .map((node) => node.nodeValue || "")
        .join(" ")
    );
  }

  function visibleTextSegments(element) {
    if (!(element instanceof Element) || !isVisible(element)) return [];
    const raw = String(element.innerText || element.textContent || "");
    return raw
      .split(/[\r\n]+/)
      .map(core.normalizeSpace)
      .filter(Boolean);
  }

  function accessibleTextCandidates(element) {
    if (!(element instanceof Element) || !isVisible(element)) return [];
    return [
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      visibleText(element),
      ...visibleTextSegments(element),
      directText(element)
    ];
  }

  function uniqueLongestFirst(candidates) {
    return [...new Set(candidates.map(core.normalizeSpace).filter(Boolean))]
      .sort((left, right) => right.length - left.length);
  }

  function orderedVisibleLeafTitleData(container) {
    const candidates = [];
    let textNodeCount = 0;
    const walker = document.createTreeWalker(container, globalThis.NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const parent = node.parentElement;
      const text = core.normalizeSpace(node.nodeValue || "");
      if (
        text &&
        parent &&
        isVisible(parent) &&
        !parent.closest(
          "button, [role='button'], script, style, noscript, input, textarea, select, option, svg, video, audio"
        )
      ) {
        textNodeCount += 1;
        if (candidates.length < 240) {
          candidates.push({
            text,
            strategy: "CARD_ORDERED_VISIBLE_LEAF",
            dom_order: textNodeCount
          });
        }
      }
      node = walker.nextNode();
    }

    const tagSequence = [container, ...container.querySelectorAll("*")]
      .filter(isVisible)
      .slice(0, 80)
      .map((element) => element.tagName.toLowerCase());
    return {
      candidates,
      context: {
        text_node_count: textNodeCount,
        anonymized_tag_sequence: tagSequence
      }
    };
  }

  function semanticTextCandidates(root) {
    if (!(root instanceof Element)) return [];
    const candidates = [];
    for (const element of allVisible(
      root,
      "h1, h2, h3, h4, h5, h6, [role='heading'], p, a[href*='myfans.jp/posts/'], [aria-label], [title]"
    )) {
      if (element.matches("button, [role='button']")) continue;
      candidates.push(...accessibleTextCandidates(element));
    }
    return uniqueLongestFirst(candidates);
  }

  function nearbyPostTextCandidates(anchor, container) {
    const candidates = [];
    let current = anchor;
    for (let depth = 0; current && current !== container && depth < 3; depth += 1, current = current.parentElement) {
      for (const sibling of [current.previousElementSibling, current.nextElementSibling]) {
        if (sibling && isVisible(sibling) && !sibling.matches("button, [role='button']")) {
          candidates.push(...accessibleTextCandidates(sibling), ...semanticTextCandidates(sibling));
        }
      }
    }
    return uniqueLongestFirst(candidates);
  }

  function postTitleCandidates(container, anchor) {
    const explicitAnchorCandidates = [
      anchor.getAttribute("aria-label"),
      anchor.getAttribute("title")
    ];
    const headingAndParagraphCandidates = [];
    for (const element of allVisible(container, "h1, h2, h3, h4, h5, h6, [role='heading'], p")) {
      headingAndParagraphCandidates.push(...accessibleTextCandidates(element));
    }
    const postLinkCandidates = accessibleTextCandidates(anchor);
    const nearbyCandidates = nearbyPostTextCandidates(anchor, container);
    const semanticCandidates = semanticTextCandidates(container);
    const leafCandidates = [];
    for (const element of allVisible(container, "span, div, a[href], [aria-label], [title]")) {
      if (element.matches("button, [role='button']")) continue;
      const nestedText = visibleText(element);
      leafCandidates.push(
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        directText(element),
        ...(element.childElementCount <= 3 && nestedText.length <= 1000
          ? [nestedText, ...visibleTextSegments(element)]
          : [])
      );
    }
    return [...new Set([
      ...explicitAnchorCandidates,
      ...uniqueLongestFirst(headingAndParagraphCandidates),
      ...uniqueLongestFirst(postLinkCandidates),
      ...nearbyCandidates,
      ...semanticCandidates,
      ...uniqueLongestFirst(leafCandidates)
    ].map(core.normalizeSpace).filter(Boolean))].slice(0, 180);
  }

  function likeCandidates(container) {
    const candidates = [];
    for (const element of allVisible(
      container,
      "[aria-label], [title], button, [role='button'], p, span, div"
    )) {
      const context = core.normalizeSpace(
        `${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""} ${directText(element)}`
      );
      if (!/(?:いいね|likes?|hearts?|[♡♥❤])/i.test(context)) continue;
      candidates.push(context);
      for (const sibling of [element.previousElementSibling, element.nextElementSibling]) {
        const siblingText = visibleText(sibling);
        if (/^[0-9][0-9,，]*$/.test(siblingText)) candidates.push(`${context} ${siblingText}`);
      }
    }
    return [...new Set(candidates.filter(Boolean))].slice(0, 40);
  }

  function creatorNameCandidates(container) {
    return linkDescriptors(container)
      .filter((link) => core.parseCreatorProfileUrl(link.href) || core.parseAffiliateCreatorRoute(link.href))
      .map((link) => link.text)
      .filter((text) => text && !text.startsWith("@"));
  }

  function planDescriptors(root) {
    const candidates = [];
    const seen = new Set();
    for (const heading of allVisible(root, "h2, h3, h4, [role='heading']")) {
      const container = closestSemanticContainer(heading);
      const text = visibleText(container);
      if (!/(?:月額|プラン価格|プラン投稿数)/.test(text) || seen.has(container)) continue;
      seen.add(container);
      const paragraphs = allVisible(container, "p").map(visibleText).filter(Boolean);
      candidates.push({
        text,
        title_candidates: [visibleText(heading)],
        description: paragraphs.find((paragraph) => paragraph !== visibleText(heading)) || null
      });
    }
    return candidates;
  }

  function descriptorForPost(anchor, sourcePageUrl, sourceSurface, collectedAt, cardSelection) {
    const container = cardSelection.container;
    const creatorCandidates = creatorNameCandidates(container);
    const leafTitleData = orderedVisibleLeafTitleData(container);
    const segmentCandidates = orderedVisibleSegmentCandidates(container);
    return {
      post_href: anchor.href,
      anchor_text: visibleText(anchor),
      text: visibleText(container),
      title_candidates: postTitleCandidates(container, anchor),
      title_segment_candidates: segmentCandidates,
      title_leaf_candidates: leafTitleData.candidates,
      title_diagnostic_context: {
        ...leafTitleData.context,
        selected_container_depth: cardSelection.evidence.depth,
        selected_container_score: cardSelection.evidence.selected_container_score,
        post_link_count: cardSelection.evidence.post_link_count,
        has_price_signal: cardSelection.evidence.has_price_signal,
        has_reward_signal: cardSelection.evidence.has_reward_signal,
        has_affiliate_copy_action: cardSelection.evidence.has_affiliate_copy_action,
        has_creator_signal: cardSelection.evidence.has_creator_signal,
        ordered_segment_count: segmentCandidates.length
      },
      creator_name_candidates: creatorCandidates,
      likes_candidates: likeCandidates(container),
      links: linkDescriptors(container),
      source_surface: sourceSurface,
      source_page_url: sourcePageUrl,
      collected_at: collectedAt
    };
  }

  function descriptorForCreator(anchor, sourcePageUrl, sourceSurface, collectedAt) {
    const container = closestSemanticContainer(anchor);
    return {
      profile_href: anchor.href,
      affiliate_creator_href: core.parseAffiliateCreatorRoute(anchor.href) ? anchor.href : null,
      text: visibleText(container),
      name_candidates: [visibleText(anchor), ...headingCandidates(container)],
      links: linkDescriptors(container),
      plan_candidates: [],
      source_surface: sourceSurface,
      source_page_url: sourcePageUrl,
      collected_at: collectedAt
    };
  }

  function descriptorForCreatorDetail(root, sourcePageUrl, sourceSurface, collectedAt) {
    const publicProfileAnchor = allVisible(root, "a[href]").find((anchor) => core.parseCreatorProfileUrl(anchor.href));
    return {
      profile_href: publicProfileAnchor?.href || null,
      affiliate_creator_href: sourcePageUrl,
      text: visibleText(root),
      name_candidates: [visibleText(publicProfileAnchor), ...headingCandidates(root)],
      links: linkDescriptors(root),
      plan_candidates: planDescriptors(root),
      source_surface: sourceSurface,
      source_page_url: sourcePageUrl,
      collected_at: collectedAt
    };
  }

  function hasUnexpectedVisibleModal() {
    return allVisible(document, "[role='dialog'], [aria-modal='true']").length > 0;
  }

  function stopCondition(sourcePageUrl) {
    return core.detectStopCondition({
      url: sourcePageUrl,
      visible_text: visibleText(document.body),
      has_login_form: Boolean(
        document.querySelector("form[action*='signin'], form[action*='login'], input[type='password']")
      ),
      has_unexpected_modal: hasUnexpectedVisibleModal()
    });
  }

  function collectCurrentPage() {
    const collectedAt = new Date().toISOString();
    const sourcePageUrl = safeSourcePageUrl(globalThis.location.href);
    const sourceSurface = core.sourceSurfaceFromUrl(sourcePageUrl);
    const stopReason = stopCondition(sourcePageUrl);
    const posts = [];
    const creators = [];
    const warnings = [];

    if (stopReason) {
      const stopped = {
        source_surface: sourceSurface,
        source_page_url: sourcePageUrl,
        collected_at: collectedAt,
        posts,
        creators,
        warnings: [`SAFETY_STOP:${stopReason}`],
        stop_reason: stopReason
      };
      stopped.fingerprint = core.fingerprintPage(stopped);
      return stopped;
    }

    const seenPostIds = new Set();
    for (const anchor of allVisible(document, "a[href]")) {
      const identity = core.parsePostUrl(anchor.href);
      if (!identity || seenPostIds.has(identity.post_uuid)) continue;
      const cardSelection = selectPostCardContainer(anchor);
      const descriptor = descriptorForPost(
        anchor,
        sourcePageUrl,
        sourceSurface,
        collectedAt,
        cardSelection
      );
      let record = core.extractPostFromDescriptor(descriptor);
      if (record && !record.title) {
        Object.assign(
          descriptor.title_diagnostic_context,
          missingTitleAncestorContext(cardSelection)
        );
        record = core.extractPostFromDescriptor(descriptor);
      }
      if (record) {
        seenPostIds.add(record.post_uuid);
        posts.push(record);
      }
    }

    if (["creator_list", "approved_creator_list"].includes(sourceSurface)) {
      const seenCreatorIds = new Set();
      for (const anchor of allVisible(document, "a[href]")) {
        const profile = core.parseCreatorProfileUrl(anchor.href);
        const affiliateCreatorRoute = core.parseAffiliateCreatorRoute(anchor.href);
        const username = profile?.username || affiliateCreatorRoute?.username;
        if (!username || seenCreatorIds.has(username.toLowerCase())) continue;
        const record = core.extractCreatorFromDescriptor(
          descriptorForCreator(anchor, sourcePageUrl, sourceSurface, collectedAt)
        );
        if (record) {
          seenCreatorIds.add(username.toLowerCase());
          creators.push(record);
        }
      }
    } else if (sourceSurface === "creator_detail") {
      const root = document.querySelector("main") || document.body;
      const record = core.extractCreatorFromDescriptor(
        descriptorForCreatorDetail(root, sourcePageUrl, sourceSurface, collectedAt)
      );
      if (record) creators.push(record);
      else warnings.push("CREATOR_DETAIL_IDENTITY_NOT_DETECTED");
    }

    if (posts.length === 0 && creators.length === 0) warnings.push("NO_CATALOG_RECORDS_DETECTED");
    const snapshot = {
      source_surface: sourceSurface,
      source_page_url: sourcePageUrl,
      collected_at: collectedAt,
      posts,
      creators,
      warnings,
      stop_reason: null
    };
    snapshot.fingerprint = core.fingerprintPage(snapshot);
    core.assertSafeExport(snapshot);
    return snapshot;
  }

  function findNextControl() {
    const candidates = allVisible(document, "button, a[href], [role='button']");
    for (const candidate of candidates) {
      const label = core.normalizeSpace(candidate.getAttribute("aria-label") || visibleText(candidate));
      if (label !== "次へ" && label !== "次のページ") continue;
      if (
        candidate.hasAttribute("disabled") ||
        candidate.getAttribute("aria-disabled") === "true" ||
        candidate.getAttribute("data-disabled") === "true"
      ) {
        return null;
      }
      return candidate;
    }
    return null;
  }

  function waitForPageChange(previousFingerprint, previousUrl, previousSnapshot) {
    return core.waitForDistinctPage({
      previous_fingerprint: previousFingerprint,
      previous_url: previousUrl,
      previous_snapshot: previousSnapshot,
      collect_current: async () => collectCurrentPage(),
      timeout_ms: 10000,
      poll_interval_ms: 250,
      now: () => Date.now(),
      sleep: (milliseconds) => new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds))
    });
  }

  function probeElements() {
    return allVisible(document, "a[href], button, [role], [aria-label], h1, h2, h3").slice(0, 200).map((element) => {
      const hierarchy = [];
      let parent = element.parentElement;
      for (let depth = 0; parent && depth < 4; depth += 1, parent = parent.parentElement) {
        hierarchy.push({ tag: parent.tagName, role: parent.getAttribute("role") });
      }
      return {
        tag: element.tagName,
        role: element.getAttribute("role"),
        aria_label: element.getAttribute("aria-label"),
        href: element instanceof HTMLAnchorElement ? element.href : null,
        button_label: element.matches("button, [role='button']") ? visibleText(element) : null,
        hierarchy
      };
    });
  }

  function probeCardFieldPresence() {
    const text = visibleText(document.body);
    return {
      price_label: /(?:単品販売価格|販売価格|価格)/.test(text),
      reward_rate_label: /(?:アフィリエイト報酬率|報酬率|報酬単価)/.test(text),
      estimated_reward_label: /(?:推定報酬|見込報酬|報酬額)/.test(text),
      duration_text: /(?:^|\s)\d{1,2}:\d{2}(?::\d{2})?(?=\s|$)/.test(text),
      likes_label: /いいね/.test(text),
      relative_time_text: /(?:たった今|昨日|\d+\s*(?:秒|分|時間|日|週間|週|か月|ヶ月|月|年)前)/.test(text),
      creator_stats_labels: /フォロワー/.test(text) && /投稿数/.test(text),
      plan_labels: /(?:プラン加入報酬率|プラン継続報酬率|月額)/.test(text)
    };
  }

  function collectProbe() {
    const collectedAt = new Date().toISOString();
    const sourcePageUrl = anonymousProbePageUrl(globalThis.location.href);
    return core.makeProbeSummary({
      source_page_url: sourcePageUrl,
      collected_at: collectedAt,
      elements: probeElements(),
      card_field_presence: probeCardFieldPresence()
    });
  }

  function collectOnePageBundle() {
    const snapshot = collectCurrentPage();
    return core.buildExport([snapshot], {
      collected_at: snapshot.collected_at,
      stop_reason: snapshot.stop_reason || "CURRENT_PAGE_ONLY"
    });
  }

  async function collectListBundle() {
    return core.runPagination({
      max_pages: 5,
      collect_current: async () => collectCurrentPage(),
      get_next_control: async () => findNextControl(),
      activate_next: async (control) => control.click(),
      wait_for_page_change: async (fingerprint, url, snapshot) => waitForPageChange(fingerprint, url, snapshot),
      collected_at: new Date().toISOString()
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return false;
    if (message.type === "MYFANS_COLLECT_CURRENT") {
      try {
        sendResponse({ ok: true, bundle: collectOnePageBundle() });
      } catch (error) {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : "COLLECTION_FAILED" });
      }
      return false;
    }
    if (message.type === "MYFANS_PROBE") {
      try {
        sendResponse({ ok: true, probe: collectProbe() });
      } catch (error) {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : "PROBE_FAILED" });
      }
      return false;
    }
    if (message.type === "MYFANS_COLLECT_LIST") {
      collectListBundle()
        .then((bundle) => sendResponse({ ok: true, bundle }))
        .catch((error) =>
          sendResponse({ ok: false, error: error instanceof Error ? error.message : "PAGINATION_FAILED" })
        );
      return true;
    }
    return false;
  });
})();
