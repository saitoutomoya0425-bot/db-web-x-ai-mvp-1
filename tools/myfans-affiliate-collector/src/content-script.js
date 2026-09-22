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

  function creatorNameCandidates(container) {
    const profileLinkNames = linkDescriptors(container)
      .filter((link) => core.parseCreatorProfileUrl(link.href) || core.parseAffiliateCreatorRoute(link.href))
      .map((link) => link.text)
      .filter((text) => text && !text.startsWith("@"));
    return [...profileLinkNames, ...headingCandidates(container)];
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

  function descriptorForPost(anchor, sourcePageUrl, sourceSurface, collectedAt) {
    const container = closestSemanticContainer(anchor);
    const headings = headingCandidates(container);
    return {
      post_href: anchor.href,
      anchor_text: visibleText(anchor),
      text: visibleText(container),
      title_candidates: [visibleText(anchor), ...headings],
      creator_name_candidates: creatorNameCandidates(container),
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
      const record = core.extractPostFromDescriptor(
        descriptorForPost(anchor, sourcePageUrl, sourceSurface, collectedAt)
      );
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

  function waitForPageChange(previousFingerprint, previousUrl) {
    return new Promise((resolve) => {
      let settled = false;
      let intervalId = null;
      let timeoutId = null;
      const observer = new MutationObserver(check);

      function finish(changed) {
        if (settled) return;
        settled = true;
        observer.disconnect();
        if (intervalId) globalThis.clearInterval(intervalId);
        if (timeoutId) globalThis.clearTimeout(timeoutId);
        resolve(changed);
      }

      function check() {
        const currentUrl = safeSourcePageUrl(globalThis.location.href);
        const snapshot = collectCurrentPage();
        if (snapshot.stop_reason || currentUrl !== previousUrl || snapshot.fingerprint !== previousFingerprint) {
          finish(true);
        }
      }

      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      intervalId = globalThis.setInterval(check, 500);
      timeoutId = globalThis.setTimeout(() => finish(false), 15000);
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
      wait_for_page_change: async (fingerprint, url) => waitForPageChange(fingerprint, url),
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
