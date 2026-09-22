(function installPopup() {
  "use strict";

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

  function renderBundle(bundle) {
    document.getElementById("post-count").textContent = String(bundle.counts.posts);
    document.getElementById("creator-count").textContent = String(bundle.counts.creators);
    document.getElementById("page-count").textContent = String(bundle.counts.pages_scanned);
    document.getElementById("warning-count").textContent = String(bundle.counts.warnings);
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

  async function send(type) {
    const tab = await activeTab();
    if (!tab.url?.startsWith("https://www.affiliate.myfans.jp/affiliates/")) {
      throw new Error("SUPPORTED_AFFILIATE_CENTER_PAGE_REQUIRED");
    }
    return chrome.tabs.sendMessage(tab.id, { type });
  }

  async function collect(type) {
    setBusy(true);
    setStatus(type === "MYFANS_COLLECT_LIST" ? "通常UIで最大5ページを確認中です…" : "表示ページを確認中です…");
    try {
      const response = await send(type);
      if (!response?.ok || !response.bundle) throw new Error(response?.error || "COLLECTION_FAILED");
      renderBundle(response.bundle);
      downloadJson(response.bundle, "myfans-affiliate-catalog");
      const safetyStops = new Set([
        "LOGIN_REDIRECT",
        "RATE_LIMIT_OR_ANTI_BOT",
        "UNEXPECTED_MODAL",
        "UNSUPPORTED_ORIGIN",
        "UNSUPPORTED_ROUTE"
      ]);
      setStatus(
        `JSONを保存しました。停止理由: ${response.bundle.stop_reason || "NONE"}`,
        safetyStops.has(response.bundle.stop_reason)
      );
    } catch (error) {
      setStatus(
        `取得できませんでした: ${error instanceof Error ? error.message : "UNKNOWN_ERROR"}。対応画面を再読み込みして再試行してください。`,
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
      const response = await send("MYFANS_PROBE");
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

  document.getElementById("collect-current").addEventListener("click", () => collect("MYFANS_COLLECT_CURRENT"));
  document.getElementById("collect-list").addEventListener("click", () => collect("MYFANS_COLLECT_LIST"));
  document.getElementById("collect-probe").addEventListener("click", probe);
})();
