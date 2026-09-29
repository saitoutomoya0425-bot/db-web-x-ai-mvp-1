"use strict";

importScripts("collector-core.js", "export-artifacts.js", "affiliate-generation-core.js", "download-delivery.js", "orchestrator-core.js", "session-core.js");

const collector = globalThis.MyFansCollectorCore;
const durable = globalThis.MyFansOrchestratorCore;
const autoSession = globalThis.MyFansAutoSessionCore;
const downloadDelivery = globalThis.MyFansDownloadDelivery;
const affiliateGeneration = globalThis.MyFansAffiliateGenerationCore;
const PILOT_TARGET_HASH = "sha256:c997ffabd37cdfbbb66eba8e04490e61de9a893d040b3a4a801fd78e46ebd3f4";
const AFFILIATE_ALARM_PREFIX = "myfans-affiliate-generation:";

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

function catalogCandidates(catalogs) {
  return Object.entries(catalogs || {})
    .filter(([, catalog]) => catalog?.collection_scope?.source_surface === "post_search")
    .filter(([, catalog]) => Array.isArray(catalog?.posts))
    .sort((left, right) => right[1].posts.length - left[1].posts.length);
}

async function readAffiliateCatalog() {
  const state = await orchestrator.readState();
  const candidates = catalogCandidates(state.catalogs);
  if (candidates.length === 0) throw new Error("AFFILIATE_TARGET_CATALOG_NOT_FOUND");
  const [scopeKey, catalog] = candidates[0];
  return { scope_key: scopeKey, catalog };
}

const affiliateOrchestrator = affiliateGeneration.createAffiliateGenerationOrchestrator({
  storage: chrome.storage.local,
  now: () => Date.now(),
  uuid: () => globalThis.crypto.randomUUID(),
  get_catalog: readAffiliateCatalog,
  prepare_target: async (tabId, target) => {
    const response = await sendToTab(tabId, { type: "MYFANS_AFFILIATE_PREPARE_TARGET", ...target });
    if (!response?.ok || !response.prepared) throw new Error(response?.error || "AFFILIATE_TARGET_PREPARE_FAILED");
    return response.prepared;
  },
  dispatch_generation: async (tabId, target) => {
    const response = await sendToTab(tabId, { type: "MYFANS_AFFILIATE_DISPATCH_GENERATION", ...target });
    if (!response?.ok || !response.ack?.accepted) throw new Error(response?.error || "AFFILIATE_GENERATION_DISPATCH_FAILED");
    return response.ack;
  },
  inspect_result: async (tabId, expected) => {
    const response = await sendToTab(tabId, { type: "MYFANS_AFFILIATE_INSPECT_RESULT", ...expected });
    if (!response?.ok || !response.result) throw new Error(response?.error || "AFFILIATE_RESULT_INSPECTION_FAILED");
    return response.result;
  },
  schedule_recovery: async (sessionId, delayMs) => {
    const boundedDelay = Math.max(250, Number(delayMs) || 250);
    globalThis.setTimeout(() => queueAffiliateRecovery(null), Math.min(boundedDelay, 30000));
    await chrome.alarms.create(`${AFFILIATE_ALARM_PREFIX}${sessionId}`, { when: Date.now() + boundedDelay });
  },
  commit_result: async (previous, next, observation) => {
    const stored = await chrome.storage.local.get([
      durable.CATALOG_KEY,
      affiliateGeneration.ACTIVE_SESSION_KEY
    ]);
    const currentJournal = stored[affiliateGeneration.ACTIVE_SESSION_KEY];
    if (
      !currentJournal ||
      currentJournal.session_id !== previous.session_id ||
      currentJournal.revision !== previous.revision ||
      currentJournal.stage !== affiliateGeneration.SESSION_STAGES.WAITING_FOR_RESULT
    ) throw new Error("AFFILIATE_COMMIT_JOURNAL_CHANGED");
    const catalogs = stored[durable.CATALOG_KEY] || {};
    const catalog = catalogs[previous.scope_key];
    if (!catalog) throw new Error("AFFILIATE_COMMIT_CATALOG_NOT_FOUND");
    const posts = (catalog.posts || []).map((post) => {
      if (post.post_uuid !== observation.post_uuid) return post;
      const existingUrl = affiliateGeneration.parseAffiliateUrl(post.displayed_affiliate_url);
      if (existingUrl && existingUrl !== observation.affiliate_url) throw new Error("AFFILIATE_URL_CONFLICT");
      const priorObservation = post.affiliate_observation || null;
      return {
        ...post,
        displayed_affiliate_url: observation.affiliate_url,
        affiliate_link_status: "ACTIVE",
        affiliate_observation: {
          ...observation,
          first_seen_at: priorObservation?.first_seen_at || observation.first_seen_at,
          first_seen_collector_version: priorObservation?.first_seen_collector_version || collector.COLLECTOR_VERSION,
          last_seen_collector_version: collector.COLLECTOR_VERSION
        }
      };
    });
    if (!posts.some((post) => post.post_uuid === observation.post_uuid)) {
      throw new Error("AFFILIATE_COMMIT_POST_NOT_FOUND");
    }
    const updatedCatalog = { ...catalog, posts };
    collector.assertSafeExport(updatedCatalog);
    await chrome.storage.local.set({
      [durable.CATALOG_KEY]: { ...catalogs, [previous.scope_key]: updatedCatalog },
      [affiliateGeneration.ACTIVE_SESSION_KEY]: next
    });
    return next;
  }
});

function queueAffiliateRecovery(tabId) {
  globalThis.setTimeout(() => {
    affiliateOrchestrator.recover(tabId).catch(() => {
      // The persistent affiliate-generation journal remains authoritative.
    });
  }, 0);
}

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
  queueAffiliateRecovery(tabId);
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

async function assertNoAffiliateGenerationActive() {
  const affiliate = await affiliateOrchestrator.getStatus();
  if (affiliate.active?.session_state === affiliateGeneration.SESSION_STATES.RUNNING) {
    throw new Error("AFFILIATE_GENERATION_SESSION_ACTIVE");
  }
}

async function assertNoCollectionActive() {
  const [operationState, sessionState] = await Promise.all([
    orchestrator.readState(),
    sessionOrchestrator.getStatus()
  ]);
  if (durable.operationActive(operationState.active) || sessionState.active?.session_state === "RUNNING") {
    throw new Error("COLLECTION_SESSION_ACTIVE");
  }
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
      await assertNoAffiliateGenerationActive();
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
      const [operation, auto, affiliate] = await Promise.all([
        orchestrator.getStatus(message.tab_id),
        sessionOrchestrator.getStatus(),
        affiliateOrchestrator.getStatus()
      ]);
      return {
        ...operation,
        auto_session: auto.active,
        last_auto_session: auto.last,
        affiliate_generation: affiliate.active,
        last_affiliate_generation: affiliate.last
      };
    });
  }

  if (message.type === "MYFANS_AFFILIATE_GENERATION_START_PILOT") {
    return respond(sendResponse, async () => {
      await assertNoCollectionActive();
      const result = await affiliateOrchestrator.start({
        session_id: message.session_id,
        tab_id: message.tab_id,
        pilot_limit: 3,
        expected_eligible_count: 1194,
        expected_target_hash: PILOT_TARGET_HASH,
        collector_version: collector.COLLECTOR_VERSION
      });
      queueAffiliateRecovery(message.tab_id);
      return result;
    });
  }

  if (message.type === "MYFANS_AFFILIATE_GENERATION_CANCEL") {
    return respond(sendResponse, () => affiliateOrchestrator.cancel(message.session_id));
  }

  if (message.type === "MYFANS_AUTO_SESSION_START") {
    return respond(sendResponse, async () => {
      await assertNoAffiliateGenerationActive();
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
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith(AFFILIATE_ALARM_PREFIX)) queueAffiliateRecovery(null);
});
chrome.runtime.onInstalled.addListener(() => {
  queueRecovery(null);
  queueExportRecovery();
});
queueRecovery(null);
queueExportRecovery();
