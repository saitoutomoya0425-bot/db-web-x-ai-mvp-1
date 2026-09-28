"use strict";

importScripts("collector-core.js", "export-artifacts.js", "download-delivery.js", "orchestrator-core.js", "session-core.js");

const collector = globalThis.MyFansCollectorCore;
const durable = globalThis.MyFansOrchestratorCore;
const autoSession = globalThis.MyFansAutoSessionCore;
const downloadDelivery = globalThis.MyFansDownloadDelivery;

async function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

const adapters = {
  storage: chrome.storage.local,
  now: () => Date.now(),
  uuid: () => globalThis.crypto.randomUUID(),
  tab_exists: async (tabId) => {
    try {
      await chrome.tabs.get(tabId);
      return true;
    } catch {
      return false;
    }
  },
  get_context: async (tabId) => {
    const response = await sendToTab(tabId, { type: "MYFANS_COLLECTION_CONTEXT" });
    if (!response?.ok || !response.context) throw new Error(response?.error || "COLLECTION_CONTEXT_FAILED");
    return response.context;
  },
  collect_page: async (tabId, expected) => {
    const response = await sendToTab(tabId, {
      type: "MYFANS_COLLECT_CURRENT_PAGE",
      operation_id: expected.operation_id || null,
      operation_stage: expected.operation_stage || null,
      expected_scope_key: expected.expected_scope_key,
      expected_page: expected.expected_page
    });
    if (!response?.ok || !response.snapshot) throw new Error(response?.error || "PAGE_COLLECTION_FAILED");
    return response.snapshot;
  },
  inspect_next: async (tabId, expected) => {
    const response = await sendToTab(tabId, {
      type: "MYFANS_INSPECT_NEXT",
      expected_scope_key: expected.expected_scope_key,
      expected_page: expected.expected_page,
      expected_fingerprint: expected.expected_fingerprint
    });
    if (!response?.ok || !response.next_control) throw new Error(response?.error || "NEXT_INSPECTION_FAILED");
    return response.next_control;
  },
  prepare_navigation: async (tabId, expected) => {
    const response = await sendToTab(tabId, {
      type: "MYFANS_PREPARE_NAVIGATION",
      ...expected
    });
    if (!response?.ok || !response.ack) throw new Error(response?.error || "NAVIGATION_PREPARE_FAILED");
    return response.ack;
  },
  navigate_now: async (tabId, expected) => {
    const response = await sendToTab(tabId, {
      type: "MYFANS_NAVIGATE_NOW",
      ...expected
    });
    if (!response?.ok || !response.ack) throw new Error(response?.error || "NAVIGATION_DISPATCH_FAILED");
    return response.ack;
  },
  navigate_tab: async (tabId, url) => {
    await chrome.tabs.update(tabId, { url });
  },
  download_artifact: async (artifact) => {
    return chrome.downloads.download(downloadDelivery.downloadOptions(artifact));
  },
  search_download: async (downloadId) => {
    const items = await chrome.downloads.search({ id: downloadId });
    return items[0] || null;
  }
};

const orchestrator = durable.createDurableOrchestrator(adapters);
const sessionOrchestrator = autoSession.createAutoSessionOrchestrator({
  storage: chrome.storage.local,
  now: () => Date.now(),
  uuid: () => globalThis.crypto.randomUUID(),
  get_context: adapters.get_context,
  chunk_orchestrator: orchestrator
});

function queueSessionRecovery(tabId) {
  globalThis.setTimeout(() => {
    sessionOrchestrator.recover(tabId).catch(() => {
      // The persistent session/chunk journals remain authoritative for the next event/startup.
    });
  }, 0);
}

function queueRecovery(tabId) {
  globalThis.setTimeout(() => {
    orchestrator.recoverActive(tabId).catch(() => {
      // The durable journal remains the source of truth for the next READY/status event.
    });
  }, 0);
  queueSessionRecovery(tabId);
}

function queueExportRecovery() {
  globalThis.setTimeout(() => {
    orchestrator.recoverExportDelivery().catch(() => {
      // The download ID and operation journal remain available for the next event/startup.
    });
  }, 0);
}

function safeFileTimestamp(value) {
  return String(value || new Date().toISOString()).replace(/[:.]/gu, "-");
}

async function downloadEphemeralJson(payload, prefix) {
  if (!["myfans-affiliate-catalog-current", "myfans-affiliate-probe"].includes(prefix)) {
    throw new Error("EPHEMERAL_EXPORT_PREFIX_INVALID");
  }
  collector.assertSafeExport(payload);
  const serializedText = `${JSON.stringify(payload, null, 2)}\n`;
  const artifact = {
    filename: `${prefix}-${safeFileTimestamp(payload.collected_at || payload.updated_at)}.json`,
    serialized_text: serializedText
  };
  return chrome.downloads.download(downloadDelivery.downloadOptions(artifact));
}

function respond(sendResponse, task) {
  Promise.resolve()
    .then(task)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : "BACKGROUND_OPERATION_FAILED"
    }));
  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  if (message.type === "MYFANS_CONTENT_READY" || message.type === "MYFANS_CONTENT_TIMEOUT") {
    const tabId = sender.tab?.id;
    if (Number.isInteger(tabId)) queueRecovery(tabId);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "MYFANS_ORCHESTRATOR_START") {
    return respond(sendResponse, async () => {
      const result = await orchestrator.start({
        operation_id: message.operation_id,
        mode: message.mode,
        tab_id: message.tab_id
      });
      queueRecovery(message.tab_id);
      return result;
    });
  }

  if (message.type === "MYFANS_ORCHESTRATOR_STATUS") {
    return respond(sendResponse, async () => {
      queueRecovery(message.tab_id);
      const [operation, auto] = await Promise.all([
        orchestrator.getStatus(message.tab_id),
        sessionOrchestrator.getStatus()
      ]);
      return { ...operation, auto_session: auto.active, last_auto_session: auto.last };
    });
  }

  if (message.type === "MYFANS_AUTO_SESSION_START") {
    return respond(sendResponse, async () => {
      const result = await sessionOrchestrator.start({
        session_id: message.session_id,
        tab_id: message.tab_id,
        configured_page_limit: message.configured_page_limit
      });
      queueSessionRecovery(message.tab_id);
      return result;
    });
  }

  if (message.type === "MYFANS_AUTO_SESSION_CANCEL") {
    return respond(sendResponse, () => sessionOrchestrator.cancel(message.session_id));
  }

  if (message.type === "MYFANS_ORCHESTRATOR_CANCEL") {
    return respond(sendResponse, () => orchestrator.cancel(message.operation_id));
  }

  if (message.type === "MYFANS_ORCHESTRATOR_START_EXPORT_DELIVERY") {
    return respond(sendResponse, () => orchestrator.startExportDelivery(
      message.operation_id,
      { confirm_ambiguous: message.confirm_ambiguous === true }
    ));
  }

  if (message.type === "MYFANS_DOWNLOAD_EPHEMERAL_JSON") {
    return respond(sendResponse, () => downloadEphemeralJson(message.payload, message.prefix));
  }

  return false;
});

chrome.downloads.onChanged.addListener((delta) => {
  orchestrator.handleDownloadChanged(delta)
    .then(() => queueSessionRecovery(null))
    .catch(() => {
      // A persisted download ID is reconciled after the next downloads event or worker startup.
    });
});

chrome.runtime.onStartup.addListener(() => {
  queueRecovery(null);
  queueExportRecovery();
});
chrome.runtime.onInstalled.addListener(() => {
  queueRecovery(null);
  queueExportRecovery();
});
queueRecovery(null);
queueExportRecovery();
