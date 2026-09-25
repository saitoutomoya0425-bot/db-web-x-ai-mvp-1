(function installPopupController() {
  "use strict";

  const exportArtifacts = globalThis.MyFansExportArtifacts;
  if (!exportArtifacts) throw new Error("MYFANS_EXPORT_ARTIFACTS_REQUIRED");
  const buttons = [...document.querySelectorAll("button")];
  const status = document.getElementById("status");
  const results = document.getElementById("results");
  const samples = document.getElementById("samples");
  const cancelButton = document.getElementById("cancel-operation");
  const exportButton = document.getElementById("export-completed");
  const refreshButton = document.getElementById("refresh-status");
  let currentOperation = null;
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

  function safeFileTimestamp(value) {
    return String(value || new Date().toISOString()).replace(/[:.]/g, "-");
  }

  function downloadJson(value, prefix) {
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    const blob = new Blob([serialized], { type: "application/json" });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = `${prefix}-${safeFileTimestamp(value.collected_at || value.updated_at)}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
  }

  function downloadArtifact(artifact) {
    const blob = new Blob([artifact.serialized_text], { type: "application/json" });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = artifact.filename;
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

  function updateActionAvailability() {
    if (busy) return;
    const active = isOperationActive(currentOperation);
    const pendingExport = Boolean(
      currentOperation?.state === "COMPLETED" && currentOperation.export_state !== "DELIVERED"
    );
    const cancellable = active && currentOperation?.state !== "COMMITTING";
    document.getElementById("collect-new").disabled = active || pendingExport;
    document.getElementById("collect-resume").disabled = active || pendingExport;
    cancelButton.hidden = !cancellable;
    cancelButton.disabled = !cancellable;
    exportButton.hidden = !(
      currentOperation?.state === "COMPLETED" &&
      ["GENERATED", "DELIVERY_FAILED"].includes(currentOperation.export_state)
    );
    exportButton.disabled = exportButton.hidden;
    refreshButton.disabled = false;
    document.getElementById("collect-current").disabled = false;
    document.getElementById("collect-probe").disabled = false;
  }

  function renderStatusView(view) {
    currentOperation = view?.operation || null;
    setText("collector-version", view?.collector_version);
    setText("stored-post-count", view?.cumulative_posts ?? 0);
    setText("checkpoint-page", view?.checkpoint_last_page);
    setText("operation-state", currentOperation?.state || "IDLE");
    setText("operation-stage", currentOperation?.stage || "—");
    setText("operation-pages", currentOperation ? `${currentOperation.pages_staged}/${currentOperation.max_pages}` : "0/5");
    setText("operation-page", currentOperation?.expected_page ?? view?.current_page);
    setText("operation-warning-count", currentOperation?.warnings?.length || 0);
    setText("operation-error", currentOperation?.failure_reason || "—");
    updateActionAvailability();

    if (isOperationActive(currentOperation)) {
      setStatus(`background収集中: ${currentOperation.stage}（${currentOperation.pages_staged}/${currentOperation.max_pages}ページ）`);
    } else if (
      currentOperation?.state === "COMPLETED" &&
      ["DELIVERING", "DELIVERY_AMBIGUOUS"].includes(currentOperation.export_state)
    ) {
      setStatus("JSON保存の完了状態を確定できません。重複防止のため自動再保存しません。", true);
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
      downloadJson(response.bundle, "myfans-affiliate-catalog-current");
      setStatus(`現在ページのJSONを保存しました。停止理由: ${response.bundle.stop_reason || "NONE"}`);
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

  async function cancelCollection() {
    if (!currentOperation?.operation_id) return;
    setBusy(true);
    try {
      await sendToBackground({
        type: "MYFANS_ORCHESTRATOR_CANCEL",
        operation_id: currentOperation.operation_id
      });
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
    let claimed = null;
    let deliveryStarted = false;
    const deliveredTypes = new Set();
    try {
      claimed = await sendToBackground({
        type: "MYFANS_ORCHESTRATOR_CLAIM_EXPORT",
        operation_id: currentOperation.operation_id
      });
      if (!claimed?.claimed || !claimed.artifacts) throw new Error(`EXPORT_NOT_AVAILABLE:${claimed?.export_state || "UNKNOWN"}`);
      const artifacts = [claimed.artifacts.run, claimed.artifacts.cumulative].filter(Boolean);
      if (artifacts.length === 0) throw new Error("EXPORT_ARTIFACT_PACKAGE_EMPTY");
      for (const artifact of artifacts) await exportArtifacts.verifyExportArtifact(artifact);
      const logical = Object.fromEntries(artifacts.map((artifact) => [
        artifact.artifact_type,
        JSON.parse(artifact.serialized_text)
      ]));
      if (logical.RUN && logical.CUMULATIVE) renderBundle(logical.RUN, logical.CUMULATIVE);
      const artifactTypes = artifacts.map((artifact) => artifact.artifact_type);
      await sendToBackground({
        type: "MYFANS_ORCHESTRATOR_EXPORT_DELIVERY_STARTED",
        operation_id: currentOperation.operation_id,
        claim_token: claimed.claim_token,
        artifact_types: artifactTypes
      });
      deliveryStarted = true;
      for (const artifact of artifacts) {
        downloadArtifact(artifact);
        await sendToBackground({
          type: "MYFANS_ORCHESTRATOR_EXPORT_DELIVERED",
          operation_id: currentOperation.operation_id,
          claim_token: claimed.claim_token,
          artifact_types: [artifact.artifact_type]
        });
        deliveredTypes.add(artifact.artifact_type);
      }
      setStatus("run/cumulative JSONを保存しました。");
      await refreshStatus({ quiet: true });
    } catch (error) {
      if (claimed?.claimed && claimed.claim_token) {
        const pendingTypes = Object.values(claimed.artifacts || {})
          .map((artifact) => artifact.artifact_type)
          .filter((type) => !deliveredTypes.has(type));
        if (pendingTypes.length > 0) {
          const messageType = deliveryStarted
            ? "MYFANS_ORCHESTRATOR_EXPORT_DELIVERY_AMBIGUOUS"
            : "MYFANS_ORCHESTRATOR_EXPORT_DELIVERY_FAILED";
          try {
            await sendToBackground({
              type: messageType,
              operation_id: currentOperation.operation_id,
              claim_token: claimed.claim_token,
              artifact_types: pendingTypes,
              reason: error instanceof Error ? error.message : "EXPORT_DELIVERY_FAILED"
            });
          } catch {
            // An unacknowledged claim stays fail-closed and cannot auto-redownload.
          }
        }
      }
      setStatus(`JSONを保存できませんでした: ${error instanceof Error ? error.message : "UNKNOWN_ERROR"}`, true);
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
