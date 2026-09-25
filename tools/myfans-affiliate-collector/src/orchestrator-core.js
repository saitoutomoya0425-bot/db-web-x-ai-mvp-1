(function installMyFansOrchestratorCore(global) {
  "use strict";

  const collector = global.MyFansCollectorCore;
  if (!collector) throw new Error("MYFANS_COLLECTOR_CORE_REQUIRED");

  const ORCHESTRATOR_SCHEMA_VERSION = "myfans-background-operation-v1";
  const ACTIVE_OPERATION_KEY = "myfansActiveCollectionOperationV1";
  const LAST_OPERATION_KEY = "myfansLastCollectionOperationV1";
  const CATALOG_KEY = "myfansCumulativeCatalogsV1";
  const READY_TIMEOUT_MS = 10000;
  const READY_POLL_INTERVAL_MS = 250;
  const READY_SETTLE_MS = 250;
  const OPERATION_STATES = Object.freeze({
    STARTING: "STARTING",
    COLLECTING_CURRENT_PAGE: "COLLECTING_CURRENT_PAGE",
    PREPARING_NAVIGATION: "PREPARING_NAVIGATION",
    WAITING_FOR_NEW_DOCUMENT: "WAITING_FOR_NEW_DOCUMENT",
    VALIDATING_NEW_DOCUMENT: "VALIDATING_NEW_DOCUMENT",
    STAGING_PAGE: "STAGING_PAGE",
    READY_TO_COMMIT: "READY_TO_COMMIT",
    COMMITTING: "COMMITTING",
    COMPLETED: "COMPLETED",
    FAILED: "FAILED",
    CANCELLED: "CANCELLED",
    PAUSED_REQUIRES_RECOVERY: "PAUSED_REQUIRES_RECOVERY"
  });
  const EXPORT_STATES = Object.freeze({
    NOT_STARTED: "NOT_STARTED",
    GENERATING: "GENERATING",
    GENERATED: "GENERATED",
    DELIVERING: "DELIVERING",
    DELIVERED: "DELIVERED"
  });
  const COMMIT_STATES = Object.freeze({
    NOT_STARTED: "NOT_STARTED",
    PREPARED: "PREPARED",
    COMMITTED: "COMMITTED"
  });
  const CANCELLATION_STATES = Object.freeze({
    ACTIVE: "ACTIVE",
    REQUESTED: "REQUESTED",
    CANCELLED: "CANCELLED"
  });
  const TERMINAL_STATES = new Set([
    OPERATION_STATES.COMPLETED,
    OPERATION_STATES.FAILED,
    OPERATION_STATES.CANCELLED,
    OPERATION_STATES.PAUSED_REQUIRES_RECOVERY
  ]);
  const ALLOWED_TRANSITIONS = Object.freeze({
    STARTING: new Set(["COLLECTING_CURRENT_PAGE", "PREPARING_NAVIGATION", "WAITING_FOR_NEW_DOCUMENT", "FAILED", "CANCELLED", "PAUSED_REQUIRES_RECOVERY"]),
    COLLECTING_CURRENT_PAGE: new Set(["STAGING_PAGE", "FAILED", "CANCELLED", "PAUSED_REQUIRES_RECOVERY"]),
    PREPARING_NAVIGATION: new Set(["WAITING_FOR_NEW_DOCUMENT", "STAGING_PAGE", "READY_TO_COMMIT", "FAILED", "CANCELLED", "PAUSED_REQUIRES_RECOVERY"]),
    WAITING_FOR_NEW_DOCUMENT: new Set(["VALIDATING_NEW_DOCUMENT", "PREPARING_NAVIGATION", "FAILED", "CANCELLED", "PAUSED_REQUIRES_RECOVERY"]),
    VALIDATING_NEW_DOCUMENT: new Set(["STAGING_PAGE", "FAILED", "CANCELLED", "PAUSED_REQUIRES_RECOVERY"]),
    STAGING_PAGE: new Set(["PREPARING_NAVIGATION", "READY_TO_COMMIT", "FAILED", "CANCELLED", "PAUSED_REQUIRES_RECOVERY"]),
    READY_TO_COMMIT: new Set(["COMMITTING", "FAILED", "CANCELLED", "PAUSED_REQUIRES_RECOVERY"]),
    COMMITTING: new Set(["COMPLETED", "FAILED", "PAUSED_REQUIRES_RECOVERY"]),
    COMPLETED: new Set([]),
    FAILED: new Set([]),
    CANCELLED: new Set([]),
    PAUSED_REQUIRES_RECOVERY: new Set([])
  });

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function isoNow(adapters) {
    return new Date(adapters.now()).toISOString();
  }

  function operationActive(operation) {
    return Boolean(operation && !TERMINAL_STATES.has(operation.state));
  }

  function catalogHash(catalog) {
    return collector.stableHash(JSON.stringify(catalog || null));
  }

  function transition(operation, nextState, patch, adapters) {
    if (!operation || !ALLOWED_TRANSITIONS[operation.state]) throw new Error("OPERATION_STATE_INVALID");
    if (!ALLOWED_TRANSITIONS[operation.state].has(nextState)) {
      throw new Error(`INVALID_OPERATION_TRANSITION:${operation.state}->${nextState}`);
    }
    const next = {
      ...operation,
      ...(patch || {}),
      state: nextState,
      stage: nextState,
      updated_at: isoNow(adapters),
      revision: operation.revision + 1
    };
    collector.assertSafeExport(next);
    return next;
  }

  function makeOperation(input, adapters) {
    if (!input.operation_id || !input.scope?.key || !Number.isInteger(input.tab_id)) {
      throw new Error("OPERATION_IDENTITY_INVALID");
    }
    const timestamp = isoNow(adapters);
    const operation = {
      schema_version: ORCHESTRATOR_SCHEMA_VERSION,
      collector_version: collector.COLLECTOR_VERSION,
      operation_id: input.operation_id,
      mode: input.mode,
      scope: clone(input.scope),
      tab_id: input.tab_id,
      state: OPERATION_STATES.STARTING,
      stage: OPERATION_STATES.STARTING,
      revision: 1,
      started_at: timestamp,
      updated_at: timestamp,
      start_page: null,
      expected_page: input.expected_page,
      last_confirmed_page: input.last_confirmed_page || null,
      pages_staged: 0,
      max_pages: collector.MAX_RUN_PAGES,
      previous_fingerprint: null,
      expected_next_evidence: null,
      staged_snapshots: [],
      pending_snapshot: null,
      navigation_base_snapshot: null,
      navigation: null,
      readiness: null,
      resume_plan: clone(input.resume_plan || null),
      warnings: [],
      failure_reason: null,
      failure_stage: null,
      cancellation_state: CANCELLATION_STATES.ACTIVE,
      commit_state: COMMIT_STATES.NOT_STARTED,
      export_state: EXPORT_STATES.NOT_STARTED,
      export_claim_token: null,
      export_delivery_attempts: 0,
      generated_export: null,
      stop_reason: null,
      completion_state: null,
      base_catalog_hash: input.base_catalog_hash,
      result: null
    };
    collector.assertSafeExport(operation);
    return operation;
  }

  function summarizeOperation(operation) {
    if (!operation) return null;
    return {
      schema_version: operation.schema_version,
      collector_version: operation.collector_version,
      operation_id: operation.operation_id,
      mode: operation.mode,
      scope_key: operation.scope?.key || null,
      tab_id: operation.tab_id,
      state: operation.state,
      stage: operation.stage,
      started_at: operation.started_at,
      updated_at: operation.updated_at,
      start_page: operation.start_page,
      expected_page: operation.expected_page,
      last_confirmed_page: operation.last_confirmed_page,
      pages_staged: operation.pages_staged,
      max_pages: operation.max_pages,
      warnings: [...(operation.warnings || [])],
      failure_reason: operation.failure_reason,
      failure_stage: operation.failure_stage,
      cancellation_state: operation.cancellation_state,
      commit_state: operation.commit_state,
      export_state: operation.export_state,
      completion_state: operation.completion_state,
      stop_reason: operation.stop_reason,
      readiness: clone(operation.readiness),
      result: clone(operation.result)
    };
  }

  function makeReadinessState(adapters, expectedPage, existingDeadline) {
    const now = adapters.now();
    const parsedDeadline = Date.parse(existingDeadline || "");
    const deadlineAt = Number.isFinite(parsedDeadline)
      ? new Date(parsedDeadline).toISOString()
      : new Date(now + READY_TIMEOUT_MS).toISOString();
    return {
      readiness_started_at: new Date(now).toISOString(),
      readiness_deadline: deadlineAt,
      expected_page: expectedPage,
      last_observed_at: null,
      last_observed_page: null,
      last_observed_record_count: 0,
      last_observed_fingerprint: null,
      settle_candidate_fingerprint: null,
      settle_candidate_record_count: 0,
      settle_candidate_at: null,
      stable_observations: 0,
      saw_expected_page: false,
      saw_records: false,
      saw_changed_fingerprint: false,
      status: "WAITING_FOR_DOCUMENT"
    };
  }

  function ensureReadinessState(operation, adapters) {
    if (operation.readiness?.readiness_deadline) return clone(operation.readiness);
    return makeReadinessState(
      adapters,
      operation.expected_page,
      operation.navigation?.deadline_at
    );
  }

  function expectedRecordCount(snapshot, operation) {
    const previous = operation.navigation_base_snapshot;
    if ((previous?.posts || []).length > 0 || operation.scope?.source_surface === "post_search") {
      return (snapshot.posts || []).length;
    }
    if ((previous?.creators || []).length > 0) return (snapshot.creators || []).length;
    return (snapshot.posts || []).length + (snapshot.creators || []).length;
  }

  function readinessFailureReason(readiness) {
    if (!readiness.saw_expected_page) return "PAGE_TRANSITION_TIMEOUT";
    if (!readiness.saw_records || readiness.last_observed_record_count < 1) {
      return "CATALOG_ROWS_NOT_READY";
    }
    if (!readiness.saw_changed_fingerprint) return "PAGE_FINGERPRINT_UNCHANGED";
    return "PAGE_SNAPSHOT_NOT_STABLE";
  }

  function observeReadinessSnapshot(operation, snapshot, adapters) {
    if (!snapshot || typeof snapshot !== "object") throw new Error("PAGE_SNAPSHOT_MISSING");
    snapshot.fingerprint = snapshot.fingerprint || collector.fingerprintPage(snapshot);
    if (snapshot.stop_reason) throw new Error(snapshot.stop_reason);
    const context = collector.collectionContextFromUrl(snapshot.source_page_url);
    if (!context) throw new Error("PAGE_CONTEXT_INVALID");
    if (context.collection_scope.key !== operation.scope.key) throw new Error("COLLECTION_SCOPE_MISMATCH");
    if (context.page !== operation.expected_page) throw new Error("EXPECTED_PAGE_MISMATCH");

    const now = adapters.now();
    const observedAt = new Date(now).toISOString();
    const readiness = ensureReadinessState(operation, adapters);
    const recordCount = expectedRecordCount(snapshot, operation);
    const changedFingerprint = snapshot.fingerprint !== operation.previous_fingerprint;
    const sameSettleCandidate = Boolean(
      readiness.settle_candidate_fingerprint &&
      readiness.settle_candidate_fingerprint === snapshot.fingerprint &&
      readiness.settle_candidate_record_count === recordCount
    );
    const next = {
      ...readiness,
      last_observed_at: observedAt,
      last_observed_page: context.page,
      last_observed_record_count: recordCount,
      last_observed_fingerprint: snapshot.fingerprint,
      saw_expected_page: true,
      saw_records: readiness.saw_records || recordCount > 0,
      saw_changed_fingerprint: readiness.saw_changed_fingerprint || (recordCount > 0 && changedFingerprint)
    };

    if (recordCount < 1) {
      Object.assign(next, {
        settle_candidate_fingerprint: null,
        settle_candidate_record_count: 0,
        settle_candidate_at: null,
        stable_observations: 0,
        status: "WAITING_FOR_ROWS"
      });
    } else if (!changedFingerprint) {
      Object.assign(next, {
        settle_candidate_fingerprint: null,
        settle_candidate_record_count: 0,
        settle_candidate_at: null,
        stable_observations: 0,
        status: "WAITING_FOR_CHANGED_FINGERPRINT"
      });
    } else if (!sameSettleCandidate) {
      Object.assign(next, {
        settle_candidate_fingerprint: snapshot.fingerprint,
        settle_candidate_record_count: recordCount,
        settle_candidate_at: observedAt,
        stable_observations: 1,
        status: "SETTLING"
      });
    } else {
      next.stable_observations = readiness.stable_observations + 1;
      const candidateAt = Date.parse(readiness.settle_candidate_at || "");
      if (Number.isFinite(candidateAt) && now - candidateAt >= READY_SETTLE_MS) {
        next.status = "READY";
        collector.assertSafeExport(snapshot);
        return { status: "READY", snapshot, context, readiness: next };
      }
      next.status = "SETTLING";
    }

    const deadline = Date.parse(next.readiness_deadline || "");
    if (Number.isFinite(deadline) && now >= deadline) {
      throw new Error(readinessFailureReason(next));
    }
    return { status: "WAIT", snapshot: null, context, readiness: next };
  }

  function validateSnapshot(snapshot, operation, options = {}) {
    if (!snapshot || typeof snapshot !== "object") throw new Error("PAGE_SNAPSHOT_MISSING");
    snapshot.fingerprint = snapshot.fingerprint || collector.fingerprintPage(snapshot);
    if (snapshot.stop_reason) throw new Error(snapshot.stop_reason);
    const context = collector.collectionContextFromUrl(snapshot.source_page_url);
    if (!context) throw new Error("PAGE_CONTEXT_INVALID");
    if (context.collection_scope.key !== operation.scope.key) throw new Error("COLLECTION_SCOPE_MISMATCH");
    if (options.expected_page != null && context.page !== options.expected_page) {
      throw new Error("EXPECTED_PAGE_MISMATCH");
    }
    if ((snapshot.posts || []).length === 0 && (snapshot.creators || []).length === 0) {
      throw new Error("NO_CATALOG_RECORDS_DETECTED");
    }
    if (options.previous_fingerprint && snapshot.fingerprint === options.previous_fingerprint) {
      throw new Error("PAGE_FINGERPRINT_UNCHANGED");
    }
    collector.assertSafeExport(snapshot);
    return { snapshot, context };
  }

  function stageSnapshot(operation, snapshot, adapters) {
    const validated = validateSnapshot(snapshot, operation, { expected_page: operation.expected_page });
    const existingPage = operation.staged_snapshots.find((item) => {
      const context = collector.collectionContextFromUrl(item.source_page_url);
      return context?.page === validated.context.page;
    });
    if (existingPage) {
      if (existingPage.fingerprint !== validated.snapshot.fingerprint) {
        throw new Error("STAGED_PAGE_CONFLICT");
      }
      return {
        operation,
        staged: false,
        snapshot: existingPage,
        context: validated.context
      };
    }
    if (operation.staged_snapshots.some((item) => item.fingerprint === validated.snapshot.fingerprint)) {
      throw new Error("DUPLICATE_PAGE_FINGERPRINT");
    }
    const stagedSnapshots = [...operation.staged_snapshots, clone(validated.snapshot)];
    const next = {
      ...operation,
      staged_snapshots: stagedSnapshots,
      pending_snapshot: null,
      navigation_base_snapshot: clone(validated.snapshot),
      start_page: operation.start_page ?? validated.context.page,
      last_confirmed_page: validated.context.page,
      expected_page: null,
      previous_fingerprint: validated.snapshot.fingerprint,
      pages_staged: stagedSnapshots.length,
      updated_at: isoNow(adapters),
      revision: operation.revision + 1
    };
    collector.assertSafeExport(next);
    return { operation: next, staged: true, snapshot: validated.snapshot, context: validated.context };
  }

  function isTransientChannelError(error) {
    return collector.isMessageChannelClosedError(error) || /CONTENT_SCRIPT_NOT_READY/i.test(String(error?.message || error));
  }

  function pauseReason(error) {
    const code = String(error?.message || error);
    return /(?:COLLECTION_SCOPE_MISMATCH|EXPECTED_PAGE_MISMATCH|TAB_NOT_AVAILABLE)/.test(code) ? code : null;
  }

  function createDurableOrchestrator(adapters) {
    const inFlight = new Map();
    let startInFlight = false;

    async function readState() {
      const stored = await adapters.storage.get([ACTIVE_OPERATION_KEY, LAST_OPERATION_KEY, CATALOG_KEY]);
      return {
        active: stored?.[ACTIVE_OPERATION_KEY] || null,
        last: stored?.[LAST_OPERATION_KEY] || null,
        catalogs: stored?.[CATALOG_KEY] && typeof stored[CATALOG_KEY] === "object"
          ? stored[CATALOG_KEY]
          : {}
      };
    }

    async function writeOperation(operation) {
      collector.assertSafeExport(operation);
      await adapters.storage.set({ [ACTIVE_OPERATION_KEY]: operation });
      return operation;
    }

    async function replaceOperation(operationId, producer) {
      const { active } = await readState();
      if (!active || active.operation_id !== operationId) throw new Error("ACTIVE_OPERATION_NOT_FOUND");
      const next = producer(active);
      await writeOperation(next);
      return next;
    }

    async function start(input) {
      if (startInFlight) throw new Error("DUPLICATE_OPERATION");
      startInFlight = true;
      try {
        const state = await readState();
        if (operationActive(state.active)) throw new Error("DUPLICATE_OPERATION");
        if (state.active?.state === OPERATION_STATES.COMPLETED && state.active.export_state !== EXPORT_STATES.DELIVERED) {
          throw new Error("PENDING_EXPORT_DELIVERY");
        }
        const context = await adapters.get_context(input.tab_id);
        if (!context?.collection_scope) throw new Error("COLLECTION_CONTEXT_FAILED");
        const existingCatalog = state.catalogs[context.collection_scope.key] || null;
        let resumePlan = null;
        let expectedPage = context.page;
        let lastConfirmedPage = null;
        if (input.mode === "NEW") {
          if (context.page !== 1) throw new Error("NEW_COLLECTION_REQUIRES_FIRST_PAGE");
        } else if (input.mode === "RESUME") {
          if (!existingCatalog?.checkpoint_summary) throw new Error("CHECKPOINT_NOT_FOUND_FOR_SCOPE");
          resumePlan = collector.validateResumeCheckpoint(
            existingCatalog.checkpoint_summary,
            context.collection_scope
          );
          expectedPage = resumePlan.page;
          lastConfirmedPage = existingCatalog.checkpoint_summary.last_successfully_collected_page;
        } else {
          throw new Error("COLLECTION_MODE_INVALID");
        }
        const operation = makeOperation({
          operation_id: input.operation_id,
          mode: input.mode,
          scope: context.collection_scope,
          tab_id: input.tab_id,
          expected_page: expectedPage,
          last_confirmed_page: lastConfirmedPage,
          resume_plan: resumePlan,
          base_catalog_hash: catalogHash(existingCatalog)
        }, adapters);
        const update = { [ACTIVE_OPERATION_KEY]: operation };
        if (state.active) update[LAST_OPERATION_KEY] = summarizeOperation(state.active);
        await adapters.storage.set(update);
        return summarizeOperation(operation);
      } finally {
        startInFlight = false;
      }
    }

    async function fail(operationId, reason) {
      return replaceOperation(operationId, (operation) => transition(
        operation,
        OPERATION_STATES.FAILED,
        {
          failure_reason: String(reason || "OPERATION_FAILED"),
          failure_stage: operation.stage,
          completion_state: "INTERRUPTED",
          commit_state: COMMIT_STATES.NOT_STARTED,
          export_state: EXPORT_STATES.NOT_STARTED
        },
        adapters
      ));
    }

    async function pause(operationId, reason) {
      return replaceOperation(operationId, (operation) => transition(
        operation,
        OPERATION_STATES.PAUSED_REQUIRES_RECOVERY,
        {
          failure_reason: String(reason || "RECOVERY_REQUIRED"),
          failure_stage: operation.stage,
          completion_state: "INTERRUPTED"
        },
        adapters
      ));
    }

    async function cancel(operationId) {
      const result = await replaceOperation(operationId, (operation) => {
        if (!operationActive(operation)) throw new Error("OPERATION_NOT_CANCELLABLE");
        return transition(operation, OPERATION_STATES.CANCELLED, {
          cancellation_state: CANCELLATION_STATES.CANCELLED,
          staged_snapshots: [],
          pending_snapshot: null,
          navigation_base_snapshot: null,
          navigation: null,
          completion_state: "INTERRUPTED",
          failure_reason: "USER_CANCELLED"
        }, adapters);
      });
      return summarizeOperation(result);
    }

    function deadlineExpired(operation) {
      const deadline = Date.parse(
        operation.readiness?.readiness_deadline || operation.navigation?.deadline_at || ""
      );
      return Number.isFinite(deadline) && adapters.now() >= deadline;
    }

    async function commitOperation(operation) {
      const state = await readState();
      const current = state.catalogs[operation.scope.key] || null;
      const alreadyCommitted = (current?.runs || []).some((run) => run.run_id === operation.operation_id);
      if (!alreadyCommitted && catalogHash(current) !== operation.base_catalog_hash) {
        throw new Error("CUMULATIVE_BASE_CHANGED");
      }
      const rawBundle = collector.buildExport(operation.staged_snapshots, {
        collected_at: operation.started_at,
        stop_reason: operation.stop_reason
      });
      const bundle = collector.attachCollectionRunMetadata(rawBundle, {
        run_id: operation.operation_id,
        mode: operation.mode,
        expected_scope_key: operation.scope.key,
        expected_start_page: operation.start_page,
        next_control: operation.expected_next_evidence
      });
      const cumulative = alreadyCommitted
        ? current
        : collector.mergeCumulativeCatalog(current, bundle).catalog;
      const completed = transition(operation, OPERATION_STATES.COMPLETED, {
        commit_state: COMMIT_STATES.COMMITTED,
        export_state: EXPORT_STATES.GENERATED,
        completion_state: bundle.collection_run.completion_state,
        generated_export: {
          run_bundle: bundle,
          cumulative_scope_key: operation.scope.key,
          cumulative_hash: catalogHash(cumulative),
          generated_at: isoNow(adapters)
        },
        result: {
          pages_collected: operation.pages_staged,
          cumulative_posts: cumulative.counts.posts,
          run_count: cumulative.run_count,
          start_page: bundle.collection_run.start_page,
          last_successfully_collected_page: bundle.collection_run.last_successfully_collected_page,
          completion_state: bundle.collection_run.completion_state,
          stop_reason: bundle.collection_run.stop_reason
        }
      }, adapters);
      const catalogs = { ...state.catalogs, [operation.scope.key]: cumulative };
      await adapters.storage.set({
        [CATALOG_KEY]: catalogs,
        [ACTIVE_OPERATION_KEY]: completed
      });
      return completed;
    }

    async function driveInternal(operationId, options = {}) {
      const maxSteps = options.max_steps || 40;
      for (let step = 0; step < maxSteps; step += 1) {
        const { active } = await readState();
        if (!active || active.operation_id !== operationId || TERMINAL_STATES.has(active.state)) {
          return active ? summarizeOperation(active) : null;
        }
        if (active.cancellation_state === CANCELLATION_STATES.REQUESTED) {
          return cancel(operationId);
        }
        try {
          if (!(await adapters.tab_exists(active.tab_id))) {
            return summarizeOperation(await pause(operationId, "TAB_NOT_AVAILABLE"));
          }

          if (active.state === OPERATION_STATES.STARTING) {
            const context = await adapters.get_context(active.tab_id);
            if (context.collection_scope.key !== active.scope.key) {
              return summarizeOperation(await pause(operationId, "COLLECTION_SCOPE_MISMATCH"));
            }
            if (active.mode === "NEW") {
              await writeOperation(transition(active, OPERATION_STATES.COLLECTING_CURRENT_PAGE, {
                expected_page: 1
              }, adapters));
              continue;
            }
            const plan = active.resume_plan;
            if (context.page !== plan.page) {
              const readiness = makeReadinessState(adapters, plan.page);
              const waiting = transition(active, OPERATION_STATES.WAITING_FOR_NEW_DOCUMENT, {
                expected_page: plan.page,
                readiness,
                navigation: {
                  kind: "POSITION",
                  source_page_url: plan.source_page_url,
                  expected_page: plan.page,
                  deadline_at: readiness.readiness_deadline
                }
              }, adapters);
              await writeOperation(waiting);
              await adapters.navigate_tab(active.tab_id, plan.source_page_url);
              return summarizeOperation(waiting);
            }
            if (plan.mode === "EXACT_URL") {
              await writeOperation(transition(active, OPERATION_STATES.COLLECTING_CURRENT_PAGE, {
                expected_page: plan.page
              }, adapters));
              continue;
            }
            const baseSnapshot = await adapters.collect_page(active.tab_id, {
              expected_scope_key: active.scope.key,
              expected_page: plan.page
            });
            validateSnapshot(baseSnapshot, active, { expected_page: plan.page });
            await writeOperation(transition(active, OPERATION_STATES.PREPARING_NAVIGATION, {
              navigation_base_snapshot: baseSnapshot,
              expected_page: plan.page,
              previous_fingerprint: baseSnapshot.fingerprint
            }, adapters));
            continue;
          }

          if (active.state === OPERATION_STATES.COLLECTING_CURRENT_PAGE) {
            const snapshot = await adapters.collect_page(active.tab_id, {
              expected_scope_key: active.scope.key,
              expected_page: active.expected_page
            });
            validateSnapshot(snapshot, active, { expected_page: active.expected_page });
            await writeOperation(transition(active, OPERATION_STATES.STAGING_PAGE, {
              pending_snapshot: snapshot
            }, adapters));
            continue;
          }

          if (active.state === OPERATION_STATES.STAGING_PAGE) {
            let staged = active;
            if (active.pending_snapshot) {
              staged = stageSnapshot(active, active.pending_snapshot, adapters).operation;
              await writeOperation(staged);
            } else if (!active.navigation_base_snapshot || active.pages_staged < 1) {
              throw new Error("STAGED_PAGE_RECOVERY_STATE_INVALID");
            }
            if (staged.pages_staged >= staged.max_pages) {
              const nextControl = await adapters.inspect_next(staged.tab_id, {
                expected_scope_key: staged.scope.key,
                expected_page: staged.last_confirmed_page,
                expected_fingerprint: staged.previous_fingerprint
              });
              const stopReason = nextControl?.present && nextControl?.enabled
                ? "MAX_PAGE_LIMIT_REACHED"
                : "NEXT_CONTROL_ABSENT_OR_DISABLED";
              await writeOperation(transition(staged, OPERATION_STATES.READY_TO_COMMIT, {
                expected_next_evidence: nextControl || { present: false, enabled: false, href: null },
                stop_reason: stopReason,
                completion_state: stopReason === "NEXT_CONTROL_ABSENT_OR_DISABLED" ? "COMPLETE" : "IN_PROGRESS"
              }, adapters));
              continue;
            }
            await writeOperation(transition(staged, OPERATION_STATES.PREPARING_NAVIGATION, {
              navigation_base_snapshot: staged.navigation_base_snapshot,
              expected_page: staged.last_confirmed_page
            }, adapters));
            continue;
          }

          if (active.state === OPERATION_STATES.PREPARING_NAVIGATION) {
            const previous = active.navigation_base_snapshot;
            const previousContext = collector.collectionContextFromUrl(previous?.source_page_url);
            if (!previous || !previousContext) throw new Error("NAVIGATION_BASE_MISSING");
            const ack = await adapters.prepare_navigation(active.tab_id, {
              operation_id: active.operation_id,
              operation_stage: OPERATION_STATES.PREPARING_NAVIGATION,
              expected_scope_key: active.scope.key,
              expected_page: previousContext.page,
              expected_fingerprint: previous.fingerprint
            });
            if (!ack?.ok || ack.from_page !== previousContext.page || ack.previous_fingerprint !== previous.fingerprint) {
              throw new Error("INVALID_NAVIGATION_ACK");
            }
            if (!ack.navigation_expected) {
              if (active.pages_staged === 0 && active.mode === "RESUME") {
                await writeOperation(transition(active, OPERATION_STATES.STAGING_PAGE, {
                  pending_snapshot: previous,
                  expected_page: previousContext.page,
                  expected_next_evidence: { present: false, enabled: false, href: null }
                }, adapters));
                continue;
              }
              await writeOperation(transition(active, OPERATION_STATES.READY_TO_COMMIT, {
                expected_next_evidence: { present: false, enabled: false, href: null },
                stop_reason: "NEXT_CONTROL_ABSENT_OR_DISABLED",
                completion_state: "COMPLETE"
              }, adapters));
              continue;
            }
            if (!Number.isInteger(ack.expected_next_page) || ack.expected_next_page <= ack.from_page) {
              throw new Error("NAVIGATION_ACK_NEXT_PAGE_INVALID");
            }
            const nonce = adapters.uuid();
            const readiness = makeReadinessState(adapters, ack.expected_next_page);
            const waiting = transition(active, OPERATION_STATES.WAITING_FOR_NEW_DOCUMENT, {
              expected_page: ack.expected_next_page,
              expected_next_evidence: ack.next_control,
              previous_fingerprint: previous.fingerprint,
              readiness,
              navigation: {
                kind: "NEXT",
                nonce,
                from_page: ack.from_page,
                expected_page: ack.expected_next_page,
                previous_fingerprint: previous.fingerprint,
                dispatched: false,
                deadline_at: readiness.readiness_deadline
              }
            }, adapters);
            await writeOperation(waiting);
            continue;
          }

          if (active.state === OPERATION_STATES.WAITING_FOR_NEW_DOCUMENT) {
            let snapshot;
            try {
              snapshot = await adapters.collect_page(active.tab_id, {
                expected_scope_key: active.scope.key,
                expected_page: null
              });
            } catch (error) {
              if (isTransientChannelError(error) && !deadlineExpired(active)) return summarizeOperation(active);
              if (isTransientChannelError(error)) throw new Error("PAGE_TRANSITION_TIMEOUT");
              throw error;
            }
            const context = collector.collectionContextFromUrl(snapshot.source_page_url);
            if (!context || context.collection_scope.key !== active.scope.key) {
              return summarizeOperation(await pause(operationId, "COLLECTION_SCOPE_MISMATCH"));
            }
            if (active.navigation.kind === "POSITION") {
              if (context.page !== active.navigation.expected_page) {
                if (deadlineExpired(active)) throw new Error("PAGE_TRANSITION_TIMEOUT");
                await adapters.navigate_tab(active.tab_id, active.navigation.source_page_url);
                return summarizeOperation(active);
              }
              const observed = observeReadinessSnapshot(active, snapshot, adapters);
              if (observed.status !== "READY") {
                const waiting = {
                  ...active,
                  readiness: observed.readiness,
                  updated_at: isoNow(adapters),
                  revision: active.revision + 1
                };
                await writeOperation(waiting);
                return summarizeOperation(waiting);
              }
              if (active.resume_plan?.mode === "VISIBLE_NEXT_FROM_LAST_PAGE") {
                await writeOperation(transition(active, OPERATION_STATES.PREPARING_NAVIGATION, {
                  navigation_base_snapshot: observed.snapshot,
                  previous_fingerprint: observed.snapshot.fingerprint,
                  navigation: null,
                  readiness: observed.readiness
                }, adapters));
              } else {
                await writeOperation(transition(active, OPERATION_STATES.VALIDATING_NEW_DOCUMENT, {
                  pending_snapshot: observed.snapshot,
                  navigation: null,
                  readiness: observed.readiness
                }, adapters));
              }
              continue;
            }
            if (context.page === active.navigation.from_page) {
              if (deadlineExpired(active)) throw new Error("PAGE_TRANSITION_TIMEOUT");
              await adapters.navigate_now(active.tab_id, {
                operation_id: active.operation_id,
                operation_stage: OPERATION_STATES.WAITING_FOR_NEW_DOCUMENT,
                expected_scope_key: active.scope.key,
                expected_page: active.navigation.from_page,
                expected_fingerprint: active.navigation.previous_fingerprint,
                navigation_nonce: active.navigation.nonce
              });
              if (!active.navigation.dispatched) {
                await writeOperation({
                  ...active,
                  navigation: { ...active.navigation, dispatched: true },
                  updated_at: isoNow(adapters),
                  revision: active.revision + 1
                });
              }
              return summarizeOperation(active);
            }
            if (context.page !== active.navigation.expected_page) {
              return summarizeOperation(await pause(operationId, "EXPECTED_PAGE_MISMATCH"));
            }
            const observed = observeReadinessSnapshot(active, snapshot, adapters);
            if (observed.status !== "READY") {
              const waiting = {
                ...active,
                readiness: observed.readiness,
                updated_at: isoNow(adapters),
                revision: active.revision + 1
              };
              await writeOperation(waiting);
              return summarizeOperation(waiting);
            }
            await writeOperation(transition(active, OPERATION_STATES.VALIDATING_NEW_DOCUMENT, {
              pending_snapshot: observed.snapshot,
              readiness: observed.readiness
            }, adapters));
            continue;
          }

          if (active.state === OPERATION_STATES.VALIDATING_NEW_DOCUMENT) {
            validateSnapshot(active.pending_snapshot, active, {
              expected_page: active.expected_page,
              previous_fingerprint: active.previous_fingerprint
            });
            await writeOperation(transition(active, OPERATION_STATES.STAGING_PAGE, {}, adapters));
            continue;
          }

          if (active.state === OPERATION_STATES.READY_TO_COMMIT) {
            await writeOperation(transition(active, OPERATION_STATES.COMMITTING, {
              commit_state: COMMIT_STATES.PREPARED,
              export_state: EXPORT_STATES.GENERATING
            }, adapters));
            continue;
          }

          if (active.state === OPERATION_STATES.COMMITTING) {
            return summarizeOperation(await commitOperation(active));
          }

          throw new Error(`UNHANDLED_OPERATION_STATE:${active.state}`);
        } catch (error) {
          if (isTransientChannelError(error) && active.state === OPERATION_STATES.WAITING_FOR_NEW_DOCUMENT) {
            return summarizeOperation(active);
          }
          const reason = pauseReason(error);
          if (reason) return summarizeOperation(await pause(operationId, reason));
          return summarizeOperation(await fail(operationId, String(error?.message || error)));
        }
      }
      if (options.fail_on_step_limit === false) {
        const { active } = await readState();
        return active ? summarizeOperation(active) : null;
      }
      return summarizeOperation(await fail(operationId, "OPERATION_STEP_LIMIT_EXCEEDED"));
    }

    async function drive(operationId) {
      if (inFlight.has(operationId)) return inFlight.get(operationId);
      const promise = driveInternal(operationId).finally(() => inFlight.delete(operationId));
      inFlight.set(operationId, promise);
      return promise;
    }

    async function driveOne(operationId) {
      return driveInternal(operationId, { max_steps: 1, fail_on_step_limit: false });
    }

    async function recoverActive(tabId) {
      const { active } = await readState();
      if (!active || !operationActive(active)) return active ? summarizeOperation(active) : null;
      if (tabId != null && active.tab_id !== tabId) return summarizeOperation(active);
      return drive(active.operation_id);
    }

    async function getStatus(tabId) {
      const state = await readState();
      let scopeKey = state.active?.scope?.key || null;
      let currentPage = null;
      if (tabId != null) {
        try {
          const context = await adapters.get_context(tabId);
          scopeKey = context.collection_scope.key;
          currentPage = context.page;
        } catch {
          // Status remains available from the durable journal while the tab is navigating.
        }
      }
      const catalog = scopeKey ? state.catalogs[scopeKey] : null;
      return {
        collector_version: collector.COLLECTOR_VERSION,
        cumulative_posts: catalog?.counts?.posts || 0,
        checkpoint_last_page: catalog?.checkpoint_summary?.last_successfully_collected_page || null,
        checkpoint_state: catalog?.checkpoint_summary?.completion_state || null,
        current_page: currentPage,
        operation: summarizeOperation(state.active),
        last_operation: clone(state.last)
      };
    }

    async function claimExports(operationId) {
      const state = await readState();
      const operation = state.active;
      if (!operation || operation.operation_id !== operationId || operation.state !== OPERATION_STATES.COMPLETED) {
        throw new Error("COMPLETED_OPERATION_NOT_FOUND");
      }
      if (![EXPORT_STATES.GENERATED, EXPORT_STATES.DELIVERING].includes(operation.export_state)) {
        return { claimed: false, export_state: operation.export_state, artifacts: null };
      }
      const catalog = state.catalogs[operation.generated_export.cumulative_scope_key];
      if (!catalog || catalogHash(catalog) !== operation.generated_export.cumulative_hash) {
        throw new Error("GENERATED_EXPORT_HASH_MISMATCH");
      }
      const token = operation.export_claim_token || adapters.uuid();
      const claimed = {
        ...operation,
        export_state: EXPORT_STATES.DELIVERING,
        export_claim_token: token,
        export_delivery_attempts: (operation.export_delivery_attempts || 0) + 1,
        updated_at: isoNow(adapters),
        revision: operation.revision + 1
      };
      await writeOperation(claimed);
      return {
        claimed: true,
        export_state: claimed.export_state,
        claim_token: token,
        artifacts: {
          run: clone(operation.generated_export.run_bundle),
          cumulative: clone(catalog)
        }
      };
    }

    async function markExportsDelivered(operationId, token) {
      const operation = await replaceOperation(operationId, (current) => {
        if (current.export_state !== EXPORT_STATES.DELIVERING || current.export_claim_token !== token) {
          throw new Error("EXPORT_CLAIM_MISMATCH");
        }
        return {
          ...current,
          export_state: EXPORT_STATES.DELIVERED,
          export_claim_token: null,
          generated_export: null,
          updated_at: isoNow(adapters),
          revision: current.revision + 1
        };
      });
      return summarizeOperation(operation);
    }

    return Object.freeze({
      cancel,
      claimExports,
      drive,
      driveOne,
      getStatus,
      markExportsDelivered,
      readState,
      recoverActive,
      start
    });
  }

  global.MyFansOrchestratorCore = Object.freeze({
    ACTIVE_OPERATION_KEY,
    CANCELLATION_STATES,
    CATALOG_KEY,
    COMMIT_STATES,
    EXPORT_STATES,
    LAST_OPERATION_KEY,
    OPERATION_STATES,
    ORCHESTRATOR_SCHEMA_VERSION,
    READY_TIMEOUT_MS,
    READY_POLL_INTERVAL_MS,
    READY_SETTLE_MS,
    createDurableOrchestrator,
    ensureReadinessState,
    makeOperation,
    observeReadinessSnapshot,
    operationActive,
    stageSnapshot,
    summarizeOperation,
    transition,
    validateSnapshot
  });
})(globalThis);
