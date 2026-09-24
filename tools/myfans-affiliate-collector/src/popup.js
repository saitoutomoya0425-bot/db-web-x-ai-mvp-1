(function installPopup() {
  "use strict";

  const core = globalThis.MyFansCollectorCore;
  const STORAGE_KEY = "myfansCumulativeCatalogsV1";
  const buttons = [...document.querySelectorAll("button")];
  const status = document.getElementById("status");
  const results = document.getElementById("results");
  const samples = document.getElementById("samples");

  function setBusy(busy) {
    for (const button of buttons) button.disabled = busy;
  }

  function setStatus(message, isError) {
    status.textContent = message;
    status.classList.toggle("error", Boolean(isError));
  }

  function safeFileTimestamp(value) {
    return String(value || new Date().toISOString()).replace(/[:.]/g, "-");
  }

  function downloadJson(value, prefix) {
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    const blob = new Blob([serialized], { type: "application/json" });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = `${prefix}-${safeFileTimestamp(value.collected_at)}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
  }

  function sampleLabel(record, type) {
    if (type === "post") {
      return `Post · ${record.title || "title未検出"} · ${record.post_uuid || "ID未検出"}`;
    }
    return `Creator · ${record.creator_name || record.username || "name未検出"} · @${record.username || "unknown"}`;
  }

  function renderBundle(bundle, cumulativeCatalog) {
    document.getElementById("post-count").textContent = String(bundle.counts.posts);
    document.getElementById("creator-count").textContent = String(bundle.counts.creators);
    document.getElementById("page-count").textContent = String(bundle.counts.pages_scanned);
    document.getElementById("warning-count").textContent = String(bundle.counts.warnings);
    document.getElementById("cumulative-post-count").textContent = String(
      cumulativeCatalog?.counts?.posts ?? bundle.counts.posts
    );
    samples.replaceChildren();
    const records = [
      ...bundle.posts.map((record) => ({ type: "post", record })),
      ...bundle.creators.map((record) => ({ type: "creator", record }))
    ].slice(0, 3);
    for (const item of records) {
      const sample = document.createElement("div");
      sample.className = "sample";
      sample.textContent = sampleLabel(item.record, item.type);
      samples.append(sample);
    }
    results.hidden = false;
  }

  async function activeTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("ACTIVE_TAB_NOT_AVAILABLE");
    return tab;
  }

  function assertSupportedTab(tab) {
    if (!tab.url?.startsWith("https://www.affiliate.myfans.jp/affiliates/")) {
      throw new Error("SUPPORTED_AFFILIATE_CENTER_PAGE_REQUIRED");
    }
  }

  async function sendToTab(tabId, message) {
    return chrome.tabs.sendMessage(tabId, message);
  }

  async function currentContext(tabId) {
    const response = await sendToTab(tabId, { type: "MYFANS_COLLECTION_CONTEXT" });
    if (!response?.ok || !response.context) throw new Error(response?.error || "COLLECTION_CONTEXT_FAILED");
    return response.context;
  }

  async function waitForContext(tabId, expectedScopeKey, expectedPage) {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= 15000) {
      try {
        const context = await currentContext(tabId);
        if (
          context.collection_scope.key === expectedScopeKey &&
          (expectedPage == null || context.page === expectedPage)
        ) {
          return context;
        }
      } catch {
        // A normal full-page navigation can temporarily unload the content script.
      }
      await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
    }
    throw new Error("RESUME_NAVIGATION_TIMEOUT");
  }

  async function navigateToObservedPage(tabId, sourcePageUrl, scopeKey, page) {
    await chrome.tabs.update(tabId, { url: sourcePageUrl });
    return waitForContext(tabId, scopeKey, page);
  }

  async function loadCatalogMap() {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const value = stored?.[STORAGE_KEY];
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  async function saveCatalogMap(catalogMap) {
    await chrome.storage.local.set({ [STORAGE_KEY]: catalogMap });
  }

  function createRunId() {
    return `run-${new Date().toISOString()}-${globalThis.crypto.randomUUID()}`;
  }

  async function collectCurrentPage() {
    setBusy(true);
    setStatus("表示ページを確認中です…");
    try {
      const tab = await activeTab();
      assertSupportedTab(tab);
      const response = await sendToTab(tab.id, { type: "MYFANS_COLLECT_CURRENT" });
      if (!response?.ok || !response.bundle) throw new Error(response?.error || "COLLECTION_FAILED");
      renderBundle(response.bundle, null);
      downloadJson(response.bundle, "myfans-affiliate-catalog-current");
      setStatus(`現在ページのJSONを保存しました。停止理由: ${response.bundle.stop_reason || "NONE"}`);
    } catch (error) {
      setStatus(`取得できませんでした: ${error instanceof Error ? error.message : "UNKNOWN_ERROR"}`, true);
    } finally {
      setBusy(false);
    }
  }

  async function resumeStartContext(tab, checkpoint, currentScope) {
    const plan = core.validateResumeCheckpoint(checkpoint, currentScope);
    await navigateToObservedPage(tab.id, plan.source_page_url, currentScope.key, plan.page);
    if (plan.mode === "EXACT_URL") return currentContext(tab.id);
    const response = await sendToTab(tab.id, {
      type: "MYFANS_PREPARE_RESUME",
      expected_scope_key: currentScope.key,
      expected_from_page: plan.page
    });
    if (!response?.ok || !response.context) {
      throw new Error(response?.error || "RESUME_PREPARATION_FAILED");
    }
    if (response.context.collection_scope.key !== currentScope.key || response.context.page === plan.page) {
      throw new Error("RESUME_TARGET_NOT_REACHED");
    }
    return response.context;
  }

  async function collectBounded(mode) {
    setBusy(true);
    setStatus(mode === "RESUME" ? "checkpointから最大5ページを収集中です…" : "新規に最大5ページを収集中です…");
    try {
      const tab = await activeTab();
      assertSupportedTab(tab);
      const initialContext = await currentContext(tab.id);
      const catalogMap = await loadCatalogMap();
      const existingCatalog = catalogMap[initialContext.collection_scope.key] || null;
      let startContext = initialContext;

      if (mode === "NEW") {
        if (initialContext.page !== 1) throw new Error("NEW_COLLECTION_REQUIRES_FIRST_PAGE");
      } else {
        if (!existingCatalog?.checkpoint_summary) throw new Error("CHECKPOINT_NOT_FOUND_FOR_SCOPE");
        startContext = await resumeStartContext(
          tab,
          existingCatalog.checkpoint_summary,
          initialContext.collection_scope
        );
      }

      const response = await sendToTab(tab.id, {
        type: "MYFANS_COLLECT_LIST",
        mode,
        run_id: createRunId(),
        expected_scope_key: startContext.collection_scope.key,
        expected_start_page: startContext.page
      });
      if (!response?.ok || !response.bundle) throw new Error(response?.error || "COLLECTION_FAILED");

      const merged = core.mergeCumulativeCatalog(existingCatalog, response.bundle);
      catalogMap[startContext.collection_scope.key] = merged.catalog;
      await saveCatalogMap(catalogMap);
      renderBundle(response.bundle, merged.catalog);
      downloadJson(response.bundle, "myfans-affiliate-catalog-run");
      downloadJson(merged.catalog, "myfans-affiliate-catalog-cumulative");

      const checkpoint = merged.catalog.checkpoint_summary;
      const hasSafetyStop = checkpoint.completion_state === "INTERRUPTED";
      setStatus(
        `run/cumulative JSONを保存しました。今回${response.bundle.counts.pages_scanned}ページ、累積${merged.catalog.counts.posts}作品、状態: ${checkpoint.completion_state} (${checkpoint.stop_reason})`,
        hasSafetyStop
      );
    } catch (error) {
      setStatus(
        `取得できませんでした: ${error instanceof Error ? error.message : "UNKNOWN_ERROR"}。checkpoint/cumulative stateは上書きしていません。`,
        true
      );
    } finally {
      setBusy(false);
    }
  }

  async function probe() {
    setBusy(true);
    setStatus("匿名化したDOM構造summaryを作成中です…");
    try {
      const tab = await activeTab();
      assertSupportedTab(tab);
      const response = await sendToTab(tab.id, { type: "MYFANS_PROBE" });
      if (!response?.ok || !response.probe) throw new Error(response?.error || "PROBE_FAILED");
      downloadJson(response.probe, "myfans-affiliate-probe");
      results.hidden = true;
      setStatus("Diagnostic JSONを保存しました。catalog値はREDACTEDです。");
    } catch (error) {
      setStatus(`Probeに失敗しました: ${error instanceof Error ? error.message : "UNKNOWN_ERROR"}`, true);
    } finally {
      setBusy(false);
    }
  }

  document.getElementById("collect-current").addEventListener("click", collectCurrentPage);
  document.getElementById("collect-new").addEventListener("click", () => collectBounded("NEW"));
  document.getElementById("collect-resume").addEventListener("click", () => collectBounded("RESUME"));
  document.getElementById("collect-probe").addEventListener("click", probe);
})();
