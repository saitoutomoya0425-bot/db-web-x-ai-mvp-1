(function installPopupController() {
  "use strict";

  const buttons = [...document.querySelectorAll("button")];
  const status = document.getElementById("status");
  const results = document.getElementById("results");
  const samples = document.getElementById("samples");
  const cancelButton = document.getElementById("cancel-operation");
  const exportButton = document.getElementById("export-completed");
  const refreshButton = document.getElementById("refresh-status");
  const autoResumeButton = document.getElementById("collect-auto-resume");
  const affiliatePilotButton = document.getElementById("affiliate-generation-pilot");
  const cancelAffiliateButton = document.getElementById("cancel-affiliate-generation");
  let currentOperation = null;
  let currentSession = null;
  let currentAffiliateSession = null;
  let busy = false;

  function setBusy(nextBusy) {
    busy = nextBusy;
    for (const button of buttons) button.disabled = nextBusy;
    if (!nextBusy) updateActionAvailability();
  }

  function setStatus(message, isError) {
    status.textContent = message;
    status.classList.toggle("error", Boolean(isError));
  }

  function setText(id, value) {
    document.getElementById(id).textContent = value == null ? "—" : String(value);
  }

  function sampleLabel(record, type) {
    if (type === "post") {
      return `Post · ${record.title || "title未検出"} · ${record.post_uuid || "ID未検出"}`;
    }
    return `Creator · ${record.creator_name || record.username || "name未検出"} · @${record.username || "unknown"}`;
  }

  function renderBundle(bundle, cumulativeCatalog) {
    setText("post-count", bundle.counts.posts);
    setText("creator-count", bundle.counts.creators);
    setText("page-count", bundle.counts.pages_scanned);
    setText("warning-count", bundle.counts.warnings);
    setText("cumulative-post-count", cumulativeCatalog?.counts?.posts ?? bundle.counts.posts);
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

  async function sendToBackground(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || "BACKGROUND_OPERATION_FAILED");
    return response.result;
  }

  function createOperationId() {
    return `operation-${new Date().toISOString()}-${globalThis.crypto.randomUUID()}`;
  }

  function isOperationActive(operation) {
    return Boolean(operation && ![
      "COMPLETED",
      "FAILED",
      "CANCELLED",
      "PAUSED_REQUIRES_RECOVERY"
    ].includes(operation.state));
  }

  function isSessionActive(autoCollection) {
    return autoCollection?.session_state === "RUNNING";
  }

  function isAffiliateSessionActive(session) {
    return session?.session_state === "RUNNING";
  }

  function elapsedLabel(startedAt, completedAt) {
    const start = Date.parse(startedAt || "");
    const parsedEnd = Date.parse(completedAt || "");
    if (!Number.isFinite(start)) return "—";
    const end = Number.isFinite(parsedEnd) ? parsedEnd : Date.now();
    const seconds = Math.max(0, Math.floor((end - start) / 1000));
    const minutes = Math.floor(seconds / 60);
    return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
  }

  function updateActionAvailability() {
    if (busy) return;
    const activeSession = isSessionActive(currentSession);
    const affiliateActive = isAffiliateSessionActive(currentAffiliateSession);
    const affiliateCancellable = affiliateActive && currentAffiliateSession?.stage !== "WAITING_FOR_RESULT";
    const active = isOperationActive(currentOperation) || activeSession || affiliateActive;
    const pendingExport = Boolean(
      currentOperation?.state === "COMPLETED" &&
      !["DELIVERED", "INTERNAL_ONLY"].includes(currentOperation.export_state)
    );
    const cancellable = active && currentOperation?.state !== "COMMITTING";
    document.getElementById("collect-new").disabled = active || pendingExport;
    document.getElementById("collect-resume").disabled = active || pendingExport;
    autoResumeButton.disabled = active || pendingExport;
    affiliatePilotButton.disabled = active || pendingExport;
    cancelButton.hidden = !cancellable;
    cancelButton.disabled = !cancellable;
    cancelAffiliateButton.hidden = !affiliateActive;
    cancelAffiliateButton.disabled = !affiliateCancellable;
    const downloadableState = currentOperation?.state === "COMPLETED" && [
      "GENERATED",
      "DELIVERY_FAILED",
      "INTERRUPTED",
      "DELIVERY_AMBIGUOUS"
    ].includes(currentOperation.export_state);
    exportButton.hidden = !downloadableState;
    exportButton.disabled = exportButton.hidden;
    exportButton.textContent = ["INTERRUPTED", "DELIVERY_AMBIGUOUS"].includes(currentOperation?.export_state)
      ? "ファイルが存在しないことを確認して再保存"
      : "完了したJSONを保存";
    refreshButton.disabled = false;
    document.getElementById("collect-current").disabled = active;
    document.getElementById("collect-probe").disabled = active;
  }

  function renderStatusView(view) {
    currentOperation = view?.operation || null;
    currentSession = view?.auto_session || null;
    currentAffiliateSession = view?.affiliate_generation || null;
    setText("collector-version", view?.collector_version);
    setText("stored-post-count", view?.cumulative_posts ?? 0);
    setText("checkpoint-page", view?.checkpoint_last_page);
    setText("operation-state", currentOperation?.state || "IDLE");
    setText("operation-stage", currentOperation?.stage || "—");
    setText("operation-pages", currentOperation ? `${currentOperation.pages_staged}/${currentOperation.max_pages}` : "0/5");
    setText("operation-page", currentOperation?.expected_page ?? view?.current_page);
    setText("operation-warning-count", currentOperation?.warnings?.length || 0);
    setText("operation-error", currentOperation?.failure_reason || "—");
    setText("session-state", currentSession?.session_state || "IDLE");
    setText("session-stage", currentSession?.stage || "—");
    setText("session-checkpoint", currentSession?.current_checkpoint);
    setText("session-chunk", currentSession?.current_chunk_number || "—");
    setText("session-pages", currentSession
      ? `${currentSession.pages_completed}/${currentSession.configured_page_limit}`
      : "0/50");
    setText("session-chunks", currentSession?.chunks_completed || 0);
    setText("session-new-posts", currentSession?.new_unique_posts || 0);
    setText("session-db-sync", currentSession?.incremental_sync?.status || "—");
    setText("session-elapsed", elapsedLabel(currentSession?.started_at, currentSession?.completed_at));
    setText("session-stop-reason", currentSession?.failure_reason || currentSession?.stop_reason || "—");
    setText("affiliate-session-state", currentAffiliateSession?.session_state || "IDLE");
    setText("affiliate-session-stage", currentAffiliateSession?.stage || "—");
    setText("affiliate-session-progress", currentAffiliateSession
      ? `${currentAffiliateSession.completed}/${currentAffiliateSession.total_targets}`
      : "0/3");
    setText("affiliate-eligible-targets", currentAffiliateSession?.eligible_target_count);
    setText("affiliate-conflicts", currentAffiliateSession?.conflicts || 0);
    setText("affiliate-stop-reason", currentAffiliateSession?.failure_reason || currentAffiliateSession?.stop_reason || "—");
    updateActionAvailability();

    if (isAffiliateSessionActive(currentAffiliateSession)) {
      setStatus(`公式UIでAffiliate URL生成パイロットを実行中です（${currentAffiliateSession.completed}/${currentAffiliateSession.total_targets}）。popupを閉じてもjournalは維持されます。`);
    } else if (isSessionActive(currentSession)) {
      setStatus(
        `収集中 — popupを閉じても続行します。${currentSession.pages_completed}/${currentSession.configured_page_limit}ページ、${currentSession.chunks_completed} chunks完了。`
      );
    } else if (isOperationActive(currentOperation)) {
      setStatus(`background収集中: ${currentOperation.stage}（${currentOperation.pages_staged}/${currentOperation.max_pages}ページ）`);
    } else if (currentAffiliateSession?.session_state === "PILOT_COMPLETED") {
      setStatus(`Affiliate URL生成パイロット完了: ${currentAffiliateSession.completed}/3。上限到達のため残りは実行していません。`);
    } else if (["FAILED", "PAUSED_REQUIRES_RECOVERY"].includes(currentAffiliateSession?.session_state)) {
      setStatus(`Affiliate URL生成を停止しました: ${currentAffiliateSession.failure_reason || currentAffiliateSession.stop_reason}`, true);
    } else if (currentSession?.session_state === "COMPLETED") {
      setStatus(
        `自動収集完了: ${currentSession.pages_completed}ページ、累積${currentSession.unique_posts_current}作品。session/cumulative JSONを保存済みです。`
      );
    } else if (["PAUSED", "FAILED"].includes(currentSession?.session_state)) {
      setStatus(
        `自動収集停止: ${currentSession.failure_reason || currentSession.stop_reason}。最後のsuccessful checkpoint ${currentSession.current_checkpoint}から再開できます。`,
        true
      );
    } else if (
      currentOperation?.state === "COMPLETED" &&
      currentOperation.export_state === "DOWNLOADING"
    ) {
      setStatus("backgroundでJSONを保存中です。popupを閉じても処理は継続します。");
    } else if (
      currentOperation?.state === "COMPLETED" &&
      ["DELIVERING", "DELIVERY_AMBIGUOUS", "INTERRUPTED"].includes(currentOperation.export_state)
    ) {
      setStatus("前回の保存を確認できませんでした。ダウンロードフォルダに対象ファイルが存在しないことを確認した場合のみ再保存してください。", true);
    } else if (currentOperation?.state === "COMPLETED") {
      setStatus(
        `収集完了: ${currentOperation.result?.pages_collected || 0}ページ、累積${currentOperation.result?.cumulative_posts || 0}作品。JSONを保存できます。`
      );
    } else if (["FAILED", "PAUSED_REQUIRES_RECOVERY"].includes(currentOperation?.state)) {
      setStatus(`収集停止: ${currentOperation.failure_reason || currentOperation.state}。正式checkpoint/cumulativeは未変更です。`, true);
    }
  }

  async function refreshStatus(options = {}) {
    try {
      let tabId = null;
      try {
        const tab = await activeTab();
        if (tab.url?.startsWith("https://www.affiliate.myfans.jp/affiliates/")) tabId = tab.id;
      } catch {
        // Durable journal status is still readable without a supported active tab.
      }
      const view = await sendToBackground({
        type: "MYFANS_ORCHESTRATOR_STATUS",
        tab_id: tabId
      });
      renderStatusView(view);
    } catch (error) {
      if (!options.quiet) setStatus(`状態を取得できませんでした: ${error instanceof Error ? error.message : "UNKNOWN_ERROR"}`, true);
    }
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
      await sendToBackground({
        type: "MYFANS_DOWNLOAD_EPHEMERAL_JSON",
        payload: response.bundle,
        prefix: "myfans-affiliate-catalog-current"
      });
      setStatus(`現在ページのJSON保存をbackgroundへ開始しました。停止理由: ${response.bundle.stop_reason || "NONE"}`);
    } catch (error) {
      setStatus(`取得できませんでした: ${error instanceof Error ? error.message : "UNKNOWN_ERROR"}`, true);
    } finally {
      setBusy(false);
    }
  }

  async function startCollection(mode) {
    setBusy(true);
    setStatus(mode === "RESUME" ? "backgroundへ続きからの収集を依頼中です…" : "backgroundへ新規収集を依頼中です…");
    try {
      const tab = await activeTab();
      assertSupportedTab(tab);
      const operation = await sendToBackground({
        type: "MYFANS_ORCHESTRATOR_START",
        operation_id: createOperationId(),
        mode,
        tab_id: tab.id
      });
      currentOperation = operation;
      setStatus(`background収集を開始しました: ${operation.operation_id}`);
      await refreshStatus({ quiet: true });
    } catch (error) {
      setStatus(`開始できませんでした: ${error instanceof Error ? error.message : "UNKNOWN_ERROR"}`, true);
    } finally {
      setBusy(false);
    }
  }

  async function startAutoCollection() {
    setBusy(true);
    setStatus("backgroundへ自動収集sessionを依頼中です…");
    try {
      const tab = await activeTab();
      assertSupportedTab(tab);
      currentSession = await sendToBackground({
        type: "MYFANS_AUTO_SESSION_START",
        session_id: `auto-${new Date().toISOString()}-${globalThis.crypto.randomUUID()}`,
        tab_id: tab.id,
        configured_page_limit: 50
      });
      setStatus("自動収集を開始しました。popupを閉じても最大50ページまで継続します。");
      await refreshStatus({ quiet: true });
    } catch (error) {
      setStatus(`自動収集を開始できませんでした: ${error instanceof Error ? error.message : "UNKNOWN_ERROR"}`, true);
    } finally {
      setBusy(false);
    }
  }

  async function startAffiliatePilot() {
    setBusy(true);
    setStatus("公式Affiliate URL生成画面を検証しています…");
    try {
      const tab = await activeTab();
      const url = new URL(tab.url || "");
      if (
        url.origin !== "https://www.affiliate.myfans.jp" ||
        !["/affiliates/search/from_url", "/affiliates/url"].includes(url.pathname.replace(/\/+$/u, ""))
      ) throw new Error("OFFICIAL_AFFILIATE_GENERATION_PAGE_REQUIRED");
      currentAffiliateSession = await sendToBackground({
        type: "MYFANS_AFFILIATE_GENERATION_START_PILOT",
        session_id: `affiliate-pilot-${new Date().toISOString()}-${globalThis.crypto.randomUUID()}`,
        tab_id: tab.id
      });
      setStatus("最大3件の公式UI生成パイロットを開始しました。4秒間隔・3件上限で必ず停止します。");
      await refreshStatus({ quiet: true });
    } catch (error) {
      setStatus(`Affiliate URL生成を開始できませんでした: ${error instanceof Error ? error.message : "UNKNOWN_ERROR"}`, true);
    } finally {
      setBusy(false);
    }
  }

  async function cancelAffiliatePilot() {
    if (!currentAffiliateSession?.session_id) return;
    setBusy(true);
    try {
      await sendToBackground({
        type: "MYFANS_AFFILIATE_GENERATION_CANCEL",
        session_id: currentAffiliateSession.session_id
      });
      await refreshStatus();
    } catch (error) {
      setStatus(`Affiliate生成を停止できませんでした: ${error instanceof Error ? error.message : "UNKNOWN_ERROR"}`, true);
    } finally {
      setBusy(false);
    }
  }

  async function cancelCollection() {
    if (!currentOperation?.operation_id && !currentSession?.session_id) return;
    setBusy(true);
    try {
      if (isSessionActive(currentSession)) {
        await sendToBackground({
          type: "MYFANS_AUTO_SESSION_CANCEL",
          session_id: currentSession.session_id
        });
      } else {
        await sendToBackground({
          type: "MYFANS_ORCHESTRATOR_CANCEL",
          operation_id: currentOperation.operation_id
        });
      }
      await refreshStatus();
    } catch (error) {
      setStatus(`キャンセルできませんでした: ${error instanceof Error ? error.message : "UNKNOWN_ERROR"}`, true);
    } finally {
      setBusy(false);
    }
  }

  async function exportCompleted() {
    if (!currentOperation?.operation_id) return;
    setBusy(true);
    try {
      const confirmAmbiguous = ["DELIVERY_AMBIGUOUS", "INTERRUPTED"].includes(currentOperation.export_state);
      await sendToBackground({
        type: "MYFANS_ORCHESTRATOR_START_EXPORT_DELIVERY",
        operation_id: currentOperation.operation_id,
        confirm_ambiguous: confirmAmbiguous
      });
      setStatus("backgroundでrun JSONの保存を開始しました。完了後にcumulative JSONを保存します。");
      await refreshStatus({ quiet: true });
    } catch (error) {
      setStatus(`JSON保存を開始できませんでした: ${error instanceof Error ? error.message : "UNKNOWN_ERROR"}`, true);
      await refreshStatus({ quiet: true });
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
      await sendToBackground({
        type: "MYFANS_DOWNLOAD_EPHEMERAL_JSON",
        payload: response.probe,
        prefix: "myfans-affiliate-probe"
      });
      results.hidden = true;
      setStatus("Diagnostic JSON保存をbackgroundへ開始しました。catalog値はREDACTEDです。");
    } catch (error) {
      setStatus(`Probeに失敗しました: ${error instanceof Error ? error.message : "UNKNOWN_ERROR"}`, true);
    } finally {
      setBusy(false);
    }
  }

  document.getElementById("collect-current").addEventListener("click", collectCurrentPage);
  autoResumeButton.addEventListener("click", startAutoCollection);
  affiliatePilotButton.addEventListener("click", startAffiliatePilot);
  cancelAffiliateButton.addEventListener("click", cancelAffiliatePilot);
  document.getElementById("collect-new").addEventListener("click", () => startCollection("NEW"));
  document.getElementById("collect-resume").addEventListener("click", () => startCollection("RESUME"));
  document.getElementById("collect-probe").addEventListener("click", probe);
  refreshButton.addEventListener("click", () => refreshStatus());
  cancelButton.addEventListener("click", cancelCollection);
  exportButton.addEventListener("click", exportCompleted);
  chrome.storage.onChanged.addListener((_changes, areaName) => {
    if (areaName === "local") refreshStatus({ quiet: true });
  });
  refreshStatus();
})();
