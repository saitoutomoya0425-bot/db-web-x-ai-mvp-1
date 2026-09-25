"use strict";

importScripts("collector-core.js", "export-artifacts.js", "orchestrator-core.js");

const collector = globalThis.MyFansCollectorCore;
const durable = globalThis.MyFansOrchestratorCore;

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
  }
};

const orchestrator = durable.createDurableOrchestrator(adapters);

function queueRecovery(tabId) {
  globalThis.setTimeout(() => {
    orchestrator.recoverActive(tabId).catch(() => {
      // The durable journal remains the source of truth for the next READY/status event.
    });
  }, 0);
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
      return orchestrator.getStatus(message.tab_id);
    });
  }

  if (message.type === "MYFANS_ORCHESTRATOR_CANCEL") {
    return respond(sendResponse, () => orchestrator.cancel(message.operation_id));
  }

  if (message.type === "MYFANS_ORCHESTRATOR_CLAIM_EXPORT") {
    return respond(sendResponse, () => orchestrator.claimExports(message.operation_id));
  }

  if (message.type === "MYFANS_ORCHESTRATOR_EXPORT_DELIVERY_STARTED") {
    return respond(sendResponse, () => orchestrator.markExportsDeliveryStarted(
      message.operation_id,
      message.claim_token,
      message.artifact_types
    ));
  }

  if (message.type === "MYFANS_ORCHESTRATOR_EXPORT_DELIVERED") {
    return respond(sendResponse, () => orchestrator.markExportsDelivered(
      message.operation_id,
      message.claim_token,
      message.artifact_types
    ));
  }

  if (message.type === "MYFANS_ORCHESTRATOR_EXPORT_DELIVERY_FAILED") {
    return respond(sendResponse, () => orchestrator.markExportsDeliveryFailed(
      message.operation_id,
      message.claim_token,
      message.artifact_types,
      message.reason
    ));
  }

  if (message.type === "MYFANS_ORCHESTRATOR_EXPORT_DELIVERY_AMBIGUOUS") {
    return respond(sendResponse, () => orchestrator.markExportsDeliveryAmbiguous(
      message.operation_id,
      message.claim_token,
      message.artifact_types,
      message.reason
    ));
  }

  return false;
});

chrome.runtime.onStartup.addListener(() => queueRecovery(null));
chrome.runtime.onInstalled.addListener(() => queueRecovery(null));
queueRecovery(null);
