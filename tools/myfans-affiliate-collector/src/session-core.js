(function installMyFansAutoSessionCore(global) {
  "use strict";

  const collector = global.MyFansCollectorCore;
  const durable = global.MyFansOrchestratorCore;
  if (!collector || !durable) throw new Error("MYFANS_SESSION_DEPENDENCIES_REQUIRED");

  const SESSION_SCHEMA_VERSION = "myfans-auto-collection-session-v1";
  const SESSION_SUMMARY_SCHEMA_VERSION = "myfans-auto-collection-session-summary-v1";
  const ACTIVE_SESSION_KEY = "myfansAutoCollectionSessionV1";
  const LAST_SESSION_KEY = "myfansLastAutoCollectionSessionV1";
  const DEFAULT_PAGE_LIMIT = 50;
  const ALLOWED_PAGE_LIMITS = new Set([25, 50, 100]);
  const SESSION_STATES = Object.freeze({
    RUNNING: "RUNNING",
    PAUSED: "PAUSED",
    COMPLETED: "COMPLETED",
    FAILED: "FAILED",
    CANCELLED: "CANCELLED"
  });
  const SESSION_STAGES = Object.freeze({
    STARTING: "STARTING",
    STARTING_CHUNK: "STARTING_CHUNK",
    RUNNING_CHUNK: "RUNNING_CHUNK",
    PROCESSING_CHUNK: "PROCESSING_CHUNK",
    PREPARING_EXPORTS: "PREPARING_EXPORTS",
    EXPORTING: "EXPORTING",
    COMPLETED: "COMPLETED",
    PAUSED: "PAUSED",
    FAILED: "FAILED",
    CANCELLED: "CANCELLED"
  });

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function isoNow(adapters) {
    return new Date(adapters.now()).toISOString();
  }

  function uniqueSorted(values) {
    return [...new Set((values || []).filter(Boolean))].sort();
  }

  function sessionActive(journal) {
    return journal?.session_state === SESSION_STATES.RUNNING;
  }

  function summarizeSession(journal) {
    if (!journal) return null;
    return {
      schema_version: journal.schema_version,
      collector_version: journal.collector_version,
      session_id: journal.session_id,
      scope_key: journal.scope?.key || null,
      tab_id: journal.tab_id,
      session_state: journal.session_state,
      stage: journal.stage,
      started_at: journal.started_at,
      updated_at: journal.updated_at,
      completed_at: journal.completed_at,
      configured_page_limit: journal.configured_page_limit,
      chunk_size: journal.chunk_size,
      start_checkpoint: journal.start_checkpoint,
      current_checkpoint: journal.current_checkpoint,
      chunks_completed: journal.chunks_completed,
      pages_completed: journal.pages_completed,
      unique_posts_before: journal.unique_posts_before,
      unique_posts_current: journal.unique_posts_current,
      new_unique_posts: journal.unique_posts_current - journal.unique_posts_before,
      current_chunk_operation_id: journal.current_chunk_operation_id,
      current_chunk_number: journal.current_chunk_number,
      end_of_catalog_detected: journal.end_of_catalog_detected,
      stop_reason: journal.stop_reason,
      failure_reason: journal.failure_reason,
      warnings: [...(journal.warnings || [])],
      incremental_sync: clone(journal.incremental_sync),
      export_state: journal.export_state || null
    };
  }

  function creatorKeysFromOperationResult(result) {
    return uniqueSorted(result?.observed_creator_keys || []);
  }

  function makeSession(input, catalog, context, adapters) {
    const pageLimit = input.configured_page_limit ?? DEFAULT_PAGE_LIMIT;
    if (!ALLOWED_PAGE_LIMITS.has(pageLimit)) throw new Error("SESSION_PAGE_LIMIT_INVALID");
    const checkpoint = catalog?.checkpoint_summary;
    if (!checkpoint) throw new Error("CHECKPOINT_NOT_FOUND_FOR_SCOPE");
    collector.validateResumeCheckpoint(checkpoint, context.collection_scope);
    const timestamp = isoNow(adapters);
    const journal = {
      schema_version: SESSION_SCHEMA_VERSION,
      collector_version: collector.COLLECTOR_VERSION,
      session_id: input.session_id,
      scope: clone(context.collection_scope),
      tab_id: input.tab_id,
      session_state: SESSION_STATES.RUNNING,
      stage: SESSION_STAGES.STARTING,
      revision: 1,
      started_at: timestamp,
      updated_at: timestamp,
      completed_at: null,
      configured_page_limit: pageLimit,
      chunk_size: collector.MAX_RUN_PAGES,
      start_checkpoint: checkpoint.last_successfully_collected_page,
      current_checkpoint: checkpoint.last_successfully_collected_page,
      chunks_completed: 0,
      pages_completed: 0,
      unique_posts_before: catalog.counts?.posts || 0,
      unique_posts_current: catalog.counts?.posts || 0,
      current_chunk_operation_id: null,
      current_chunk_number: 0,
      completed_chunk_operation_ids: [],
      chunk_summaries: [],
      observed_post_uuids: [],
      observed_creator_keys: [],
      baseline: collector.buildIncrementalBaseline(catalog),
      end_of_catalog_detected: false,
      stop_reason: null,
      failure_reason: null,
      warnings: [],
      incremental_sync: null,
      export_state: null
    };
    collector.assertSafeExport(journal);
    return journal;
  }

  function makeSessionSummary(journal, incrementalSync, completedAt) {
    const summary = {
      schema_version: SESSION_SUMMARY_SCHEMA_VERSION,
      collector_version: collector.COLLECTOR_VERSION,
      export_kind: "AUTO_COLLECTION_SESSION",
      source: {
        system: "MyFans Affiliate Center",
        mode: "RENDERED_UI_TEXT",
        host: collector.AFFILIATE_HOST
      },
      collected_at: journal.started_at,
      completed_at: completedAt,
      collection_scope: clone(journal.scope),
      auto_collection: {
        session_id: journal.session_id,
        start_checkpoint: journal.start_checkpoint,
        last_successfully_collected_page: journal.current_checkpoint,
        configured_page_limit: journal.configured_page_limit,
        pages_completed: journal.pages_completed,
        chunks_completed: journal.chunks_completed,
        end_of_catalog_detected: journal.end_of_catalog_detected,
        stop_reason: journal.stop_reason
      },
      chunks: clone(journal.chunk_summaries),
      incremental_sync: clone(incrementalSync),
      counts: {
        pages_scanned: journal.pages_completed,
        chunks: journal.chunks_completed,
        posts_observed_unique: journal.observed_post_uuids.length,
        creators_observed_unique: journal.observed_creator_keys.length,
        cumulative_posts_before: journal.unique_posts_before,
        cumulative_posts_after: journal.unique_posts_current,
        new_unique_posts: journal.unique_posts_current - journal.unique_posts_before,
        warnings: journal.warnings.length
      },
      warnings: [...journal.warnings]
    };
    collector.assertSafeExport(summary);
    return summary;
  }

  function createAutoSessionOrchestrator(adapters) {
    if (!adapters?.storage || !adapters?.chunk_orchestrator || !adapters?.get_context) {
      throw new Error("SESSION_ADAPTERS_INVALID");
    }
    const chunkOrchestrator = adapters.chunk_orchestrator;
    const inFlight = new Map();
    let startInFlight = false;

    async function readJournal() {
      const stored = await adapters.storage.get([ACTIVE_SESSION_KEY, LAST_SESSION_KEY]);
      return {
        active: stored?.[ACTIVE_SESSION_KEY] || null,
        last: stored?.[LAST_SESSION_KEY] || null
      };
    }

    async function writeJournal(journal) {
      collector.assertSafeExport(journal);
      await adapters.storage.set({ [ACTIVE_SESSION_KEY]: journal });
      return journal;
    }

    async function updateJournal(sessionId, producer) {
      const { active } = await readJournal();
      if (!active || active.session_id !== sessionId) throw new Error("AUTO_SESSION_NOT_FOUND");
      const next = producer(active);
      collector.assertSafeExport(next);
      await adapters.storage.set({ [ACTIVE_SESSION_KEY]: next });
      return next;
    }

    function patchJournal(journal, patch) {
      return {
        ...journal,
        ...patch,
        updated_at: isoNow(adapters),
        revision: journal.revision + 1
      };
    }

    async function start(input) {
      if (startInFlight) throw new Error("DUPLICATE_AUTO_SESSION");
      startInFlight = true;
      try {
        if (!input?.session_id || !Number.isInteger(input.tab_id)) throw new Error("AUTO_SESSION_IDENTITY_INVALID");
        const prior = await readJournal();
        if (sessionActive(prior.active)) throw new Error("DUPLICATE_AUTO_SESSION");
        const context = await adapters.get_context(input.tab_id);
        if (!context?.collection_scope) throw new Error("COLLECTION_CONTEXT_FAILED");
        const operationState = await chunkOrchestrator.readState();
        const catalog = operationState.catalogs[context.collection_scope.key];
        if (!catalog) throw new Error("CUMULATIVE_CATALOG_NOT_FOUND");
        const activeOperation = operationState.active;
        if (durable.operationActive(activeOperation)) throw new Error("DUPLICATE_OPERATION");
        if (
          activeOperation?.state === durable.OPERATION_STATES.COMPLETED &&
          activeOperation.export_state !== durable.EXPORT_STATES.DELIVERED &&
          activeOperation.export_state !== durable.EXPORT_STATES.INTERNAL_ONLY
        ) throw new Error("PENDING_EXPORT_DELIVERY");
        const journal = makeSession(input, catalog, context, adapters);
        const update = { [ACTIVE_SESSION_KEY]: journal };
        if (prior.active) update[LAST_SESSION_KEY] = summarizeSession(prior.active);
        await adapters.storage.set(update);
        return summarizeSession(journal);
      } finally {
        startInFlight = false;
      }
    }

    async function pauseSession(journal, reason, state = SESSION_STATES.PAUSED) {
      const terminalStage = state === SESSION_STATES.FAILED ? SESSION_STAGES.FAILED : SESSION_STAGES.PAUSED;
      return writeJournal(patchJournal(journal, {
        session_state: state,
        stage: terminalStage,
        failure_reason: String(reason || "AUTO_SESSION_PAUSED"),
        stop_reason: String(reason || "AUTO_SESSION_PAUSED")
      }));
    }

    async function startChunk(journal) {
      const chunkNumber = journal.chunks_completed + 1;
      const operationId = `${journal.session_id}:chunk:${chunkNumber}`;
      let starting = patchJournal(journal, {
        stage: SESSION_STAGES.STARTING_CHUNK,
        current_chunk_number: chunkNumber,
        current_chunk_operation_id: operationId
      });
      await writeJournal(starting);
      const operationState = await chunkOrchestrator.readState();
      if (operationState.active?.operation_id !== operationId) {
        await chunkOrchestrator.start({
          operation_id: operationId,
          parent_session_id: journal.session_id,
          export_policy: "SESSION_INTERNAL",
          mode: "RESUME",
          tab_id: journal.tab_id
        });
      }
      starting = await updateJournal(journal.session_id, (current) => patchJournal(current, {
        stage: SESSION_STAGES.RUNNING_CHUNK
      }));
      return starting;
    }

    function chunkSummary(operation) {
      return {
        operation_id: operation.operation_id,
        chunk_number: null,
        start_page: operation.result?.start_page,
        last_successfully_collected_page: operation.result?.last_successfully_collected_page,
        pages_collected: operation.result?.pages_collected,
        posts_observed: operation.result?.posts_observed,
        creators_observed: operation.result?.creators_observed,
        cumulative_posts: operation.result?.cumulative_posts,
        completion_state: operation.result?.completion_state,
        stop_reason: operation.result?.stop_reason,
        merge: clone(operation.result?.merge)
      };
    }

    async function recordCommittedChunk(journal, operation) {
      if (journal.completed_chunk_operation_ids.includes(operation.operation_id)) return journal;
      if (
        operation.parent_session_id !== journal.session_id ||
        operation.export_policy !== "SESSION_INTERNAL" ||
        operation.commit_state !== durable.COMMIT_STATES.COMMITTED ||
        operation.export_state !== durable.EXPORT_STATES.INTERNAL_ONLY
      ) throw new Error("AUTO_SESSION_CHUNK_CONTRACT_INVALID");
      const result = operation.result || {};
      const pages = Number(result.pages_collected || 0);
      if (pages < 1 || pages > collector.MAX_RUN_PAGES) throw new Error("AUTO_SESSION_CHUNK_PAGE_COUNT_INVALID");
      if (result.start_page !== journal.current_checkpoint + 1) throw new Error("AUTO_SESSION_CHUNK_START_MISMATCH");
      const summary = chunkSummary(operation);
      summary.chunk_number = journal.chunks_completed + 1;
      return writeJournal(patchJournal(journal, {
        stage: SESSION_STAGES.PROCESSING_CHUNK,
        current_checkpoint: result.last_successfully_collected_page,
        chunks_completed: journal.chunks_completed + 1,
        pages_completed: journal.pages_completed + pages,
        unique_posts_current: result.cumulative_posts,
        completed_chunk_operation_ids: [...journal.completed_chunk_operation_ids, operation.operation_id],
        chunk_summaries: [...journal.chunk_summaries, summary],
        observed_post_uuids: uniqueSorted([
          ...journal.observed_post_uuids,
          ...(result.observed_post_uuids || [])
        ]),
        observed_creator_keys: uniqueSorted([
          ...journal.observed_creator_keys,
          ...creatorKeysFromOperationResult(result)
        ]),
        warnings: uniqueSorted([
          ...journal.warnings,
          ...(operation.warnings || []),
          ...(result.warnings || [])
        ]),
        end_of_catalog_detected: result.completion_state === "COMPLETE",
        stop_reason: result.stop_reason,
        current_chunk_operation_id: operation.operation_id
      }));
    }

    async function prepareFinalExports(journal, operation) {
      const state = await chunkOrchestrator.readState();
      const catalog = state.catalogs[journal.scope.key];
      if (!catalog) throw new Error("SESSION_FINAL_CATALOG_MISSING");
      if (catalog.checkpoint_summary?.last_successfully_collected_page !== journal.current_checkpoint) {
        throw new Error("SESSION_FINAL_CHECKPOINT_MISMATCH");
      }
      const incrementalSync = collector.classifyIncrementalSelection(catalog, journal.baseline, {
        post_uuids: journal.observed_post_uuids,
        creator_keys: journal.observed_creator_keys
      });
      if (incrementalSync.status !== "DB_SYNC_READY") throw new Error("INCREMENTAL_SYNC_CONFLICT");
      const completedAt = isoNow(adapters);
      const summary = makeSessionSummary(journal, incrementalSync, completedAt);
      await writeJournal(patchJournal(journal, {
        stage: SESSION_STAGES.PREPARING_EXPORTS,
        incremental_sync: incrementalSync,
        export_state: durable.EXPORT_STATES.GENERATING
      }));
      await chunkOrchestrator.prepareSessionExports(operation.operation_id, summary, incrementalSync);
      await updateJournal(journal.session_id, (current) => patchJournal(current, {
        stage: SESSION_STAGES.EXPORTING,
        export_state: durable.EXPORT_STATES.GENERATED
      }));
      await chunkOrchestrator.startExportDelivery(operation.operation_id);
    }

    async function driveInternal(sessionId) {
      for (let step = 0; step < 20; step += 1) {
        let { active: journal } = await readJournal();
        if (!journal || journal.session_id !== sessionId || !sessionActive(journal)) {
          return summarizeSession(journal);
        }
        try {
          if (!journal.current_chunk_operation_id) {
            journal = await startChunk(journal);
          }
          let operationState = await chunkOrchestrator.readState();
          let operation = operationState.active;
          if (!operation || operation.operation_id !== journal.current_chunk_operation_id) {
            if (journal.stage === SESSION_STAGES.STARTING_CHUNK) {
              await chunkOrchestrator.start({
                operation_id: journal.current_chunk_operation_id,
                parent_session_id: journal.session_id,
                export_policy: "SESSION_INTERNAL",
                mode: "RESUME",
                tab_id: journal.tab_id
              });
              journal = await updateJournal(journal.session_id, (current) => patchJournal(current, {
                stage: SESSION_STAGES.RUNNING_CHUNK
              }));
              operationState = await chunkOrchestrator.readState();
              operation = operationState.active;
            }
            if (!operation || operation.operation_id !== journal.current_chunk_operation_id) {
              return summarizeSession(await pauseSession(journal, "AUTO_SESSION_CHUNK_NOT_FOUND", SESSION_STATES.FAILED));
            }
          }

          if (operation.export_policy === "SESSION_FINAL") {
            if (operation.export_state === durable.EXPORT_STATES.DELIVERED) {
              const completed = await writeJournal(patchJournal(journal, {
                session_state: SESSION_STATES.COMPLETED,
                stage: SESSION_STAGES.COMPLETED,
                completed_at: isoNow(adapters),
                export_state: operation.export_state,
                failure_reason: null
              }));
              return summarizeSession(completed);
            }
            if (operation.export_state === durable.EXPORT_STATES.DOWNLOADING) {
              await chunkOrchestrator.recoverExportDelivery();
              return summarizeSession((await readJournal()).active);
            }
            if (operation.export_state === durable.EXPORT_STATES.GENERATED) {
              await chunkOrchestrator.startExportDelivery(operation.operation_id);
              return summarizeSession((await readJournal()).active);
            }
            if ([
              durable.EXPORT_STATES.DELIVERY_AMBIGUOUS,
              durable.EXPORT_STATES.DELIVERY_FAILED,
              durable.EXPORT_STATES.INTERRUPTED
            ].includes(operation.export_state)) {
              return summarizeSession(await pauseSession(journal, `AUTO_EXPORT_${operation.export_state}`));
            }
            return summarizeSession(journal);
          }

          if (durable.operationActive(operation)) {
            await chunkOrchestrator.drive(operation.operation_id);
            operationState = await chunkOrchestrator.readState();
            operation = operationState.active;
            if (durable.operationActive(operation)) return summarizeSession(journal);
          }

          if (operation.state === durable.OPERATION_STATES.COMPLETED) {
            journal = await recordCommittedChunk(journal, operation);
            if (journal.warnings.length > 0) {
              return summarizeSession(await pauseSession(journal, "AUTO_SESSION_CHUNK_WARNING"));
            }
            const reachedEnd = operation.result?.completion_state === "COMPLETE";
            const reachedLimit = journal.pages_completed >= journal.configured_page_limit;
            if (reachedEnd || reachedLimit) {
              journal = await writeJournal(patchJournal(journal, {
                stop_reason: reachedEnd ? "CATALOG_COMPLETE" : "SESSION_PAGE_LIMIT_REACHED",
                end_of_catalog_detected: reachedEnd,
                stage: SESSION_STAGES.PREPARING_EXPORTS
              }));
              await prepareFinalExports(journal, operation);
              continue;
            }
            journal = await writeJournal(patchJournal(journal, {
              current_chunk_operation_id: null,
              stage: SESSION_STAGES.STARTING_CHUNK
            }));
            continue;
          }

          if (operation.state === durable.OPERATION_STATES.CANCELLED) {
            const cancelled = await writeJournal(patchJournal(journal, {
              session_state: SESSION_STATES.CANCELLED,
              stage: SESSION_STAGES.CANCELLED,
              stop_reason: "USER_CANCELLED",
              failure_reason: "USER_CANCELLED"
            }));
            return summarizeSession(cancelled);
          }
          if ([durable.OPERATION_STATES.FAILED, durable.OPERATION_STATES.PAUSED_REQUIRES_RECOVERY].includes(operation.state)) {
            return summarizeSession(await pauseSession(journal, operation.failure_reason || operation.state));
          }
          return summarizeSession(journal);
        } catch (error) {
          const reason = String(error?.message || error);
          const contractFailure = /(?:CONFLICT|CONTRACT|MISMATCH|INVALID|BASE_CHANGED)/u.test(reason);
          return summarizeSession(await pauseSession(
            journal,
            reason,
            contractFailure ? SESSION_STATES.FAILED : SESSION_STATES.PAUSED
          ));
        }
      }
      const { active } = await readJournal();
      return summarizeSession(await pauseSession(active, "AUTO_SESSION_STEP_LIMIT", SESSION_STATES.FAILED));
    }

    function drive(sessionId) {
      if (inFlight.has(sessionId)) return inFlight.get(sessionId);
      const promise = driveInternal(sessionId).finally(() => inFlight.delete(sessionId));
      inFlight.set(sessionId, promise);
      return promise;
    }

    async function recover(tabId) {
      const { active } = await readJournal();
      if (
        active?.session_state === SESSION_STATES.PAUSED &&
        /^AUTO_EXPORT_/u.test(active.failure_reason || "")
      ) {
        const operation = (await chunkOrchestrator.readState()).active;
        if (operation?.operation_id === active.current_chunk_operation_id) {
          if (operation.export_state === durable.EXPORT_STATES.DELIVERED) {
            return summarizeSession(await writeJournal(patchJournal(active, {
              session_state: SESSION_STATES.COMPLETED,
              stage: SESSION_STAGES.COMPLETED,
              completed_at: isoNow(adapters),
              export_state: operation.export_state,
              failure_reason: null
            })));
          }
          if (operation.export_state === durable.EXPORT_STATES.DOWNLOADING) {
            const resumed = await writeJournal(patchJournal(active, {
              session_state: SESSION_STATES.RUNNING,
              stage: SESSION_STAGES.EXPORTING,
              export_state: operation.export_state,
              failure_reason: null
            }));
            return drive(resumed.session_id);
          }
        }
      }
      if (!sessionActive(active)) return summarizeSession(active);
      if (tabId != null && active.tab_id !== tabId) return summarizeSession(active);
      return drive(active.session_id);
    }

    async function cancel(sessionId) {
      const { active } = await readJournal();
      if (!active || active.session_id !== sessionId || !sessionActive(active)) {
        throw new Error("AUTO_SESSION_NOT_CANCELLABLE");
      }
      const operation = (await chunkOrchestrator.readState()).active;
      if (operation && operation.operation_id === active.current_chunk_operation_id && durable.operationActive(operation)) {
        await chunkOrchestrator.cancel(operation.operation_id);
      }
      const cancelled = await writeJournal(patchJournal(active, {
        session_state: SESSION_STATES.CANCELLED,
        stage: SESSION_STAGES.CANCELLED,
        stop_reason: "USER_CANCELLED",
        failure_reason: "USER_CANCELLED"
      }));
      return summarizeSession(cancelled);
    }

    async function getStatus() {
      const { active, last } = await readJournal();
      return { active: summarizeSession(active), last: clone(last) };
    }

    return Object.freeze({ cancel, drive, getStatus, readJournal, recover, start });
  }

  global.MyFansAutoSessionCore = Object.freeze({
    ACTIVE_SESSION_KEY,
    ALLOWED_PAGE_LIMITS,
    DEFAULT_PAGE_LIMIT,
    LAST_SESSION_KEY,
    SESSION_SCHEMA_VERSION,
    SESSION_STAGES,
    SESSION_STATES,
    SESSION_SUMMARY_SCHEMA_VERSION,
    createAutoSessionOrchestrator,
    makeSession,
    makeSessionSummary,
    sessionActive,
    summarizeSession
  });
})(globalThis);
