(function installMyFansAffiliateGenerationCore(global) {
  "use strict";

  const exportArtifacts = global.MyFansExportArtifacts;
  if (!exportArtifacts) throw new Error("MYFANS_EXPORT_ARTIFACTS_REQUIRED");

  const SESSION_SCHEMA_VERSION = "myfans-affiliate-generation-session-v1";
  const ACTIVE_SESSION_KEY = "myfansAffiliateGenerationSessionV1";
  const LAST_SESSION_KEY = "myfansLastAffiliateGenerationSessionV1";
  const PILOT_MAX_TARGETS = 3;
  const FUTURE_BATCH_SIZE = 20;
  const GENERATION_COOLDOWN_MS = 4000;
  const RESULT_TIMEOUT_MS = 30000;
  const SESSION_STATES = Object.freeze({
    RUNNING: "RUNNING",
    PILOT_COMPLETED: "PILOT_COMPLETED",
    FAILED: "FAILED",
    CANCELLED: "CANCELLED",
    PAUSED_REQUIRES_RECOVERY: "PAUSED_REQUIRES_RECOVERY"
  });
  const SESSION_STAGES = Object.freeze({
    FREEZING_TARGETS: "FREEZING_TARGETS",
    PREPARING_TARGET: "PREPARING_TARGET",
    READY_TO_DISPATCH: "READY_TO_DISPATCH",
    WAITING_FOR_RESULT: "WAITING_FOR_RESULT",
    COOLDOWN: "COOLDOWN",
    PILOT_COMPLETED: "PILOT_COMPLETED",
    FAILED: "FAILED",
    CANCELLED: "CANCELLED",
    PAUSED_REQUIRES_RECOVERY: "PAUSED_REQUIRES_RECOVERY"
  });

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  const GENERATION_ROUTES = new Set([
    "/affiliates/search/from_url",
    "/affiliates/url"
  ]);
  const GENERATION_SURFACES = Object.freeze({
    SEARCH_RESULT_CARD: "SEARCH_RESULT_CARD",
    DEDICATED_FORM: "DEDICATED_FORM"
  });

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function isoNow(adapters) {
    return new Date(adapters.now()).toISOString();
  }

  function normalizedHttpsUrl(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const url = new URL(value.trim());
      if (
        url.protocol !== "https:" ||
        url.username !== "" ||
        url.password !== "" ||
        (url.port !== "" && url.port !== "443")
      ) return null;
      return url;
    } catch {
      return null;
    }
  }

  function parseCanonicalPostUrl(value) {
    const url = normalizedHttpsUrl(value);
    if (!url || url.hostname.toLowerCase() !== "myfans.jp" || url.search || url.hash) return null;
    const match = url.pathname.match(/^\/posts\/([0-9a-f-]{36})\/?$/iu);
    if (!match || !UUID_RE.test(match[1])) return null;
    const postUuid = match[1].toLowerCase();
    return {
      post_uuid: postUuid,
      canonical_url: `https://myfans.jp/posts/${postUuid}`
    };
  }

  function parseAffiliateUrl(value) {
    const url = normalizedHttpsUrl(value);
    if (!url || url.hostname.toLowerCase() !== "link.affiliate.myfans.jp" || url.hash) return null;
    if ((!url.pathname || url.pathname === "/") && !url.search) return null;
    return url.href;
  }

  function affiliateUrlShape(value) {
    const parsed = parseAffiliateUrl(value);
    if (!parsed) return null;
    const url = new URL(parsed);
    return {
      host: url.hostname.toLowerCase(),
      path_segment_count: url.pathname.split("/").filter(Boolean).length,
      query_keys: [...new Set([...url.searchParams.keys()])].sort()
    };
  }

  function generationRoute(value) {
    const url = normalizedHttpsUrl(value);
    if (!url || url.hostname !== "www.affiliate.myfans.jp") return null;
    const path = url.pathname.replace(/\/+$/u, "") || "/";
    return GENERATION_ROUTES.has(path) ? path : null;
  }

  function normalizeTarget(post) {
    const identity = parseCanonicalPostUrl(post?.post_public_url);
    if (
      !identity ||
      identity.post_uuid !== String(post?.post_uuid || "").toLowerCase() ||
      post?.affiliate_eligible !== true ||
      post?.displayed_affiliate_url ||
      String(post?.affiliate_link_status || "").toUpperCase() === "ACTIVE"
    ) return null;
    return identity;
  }

  function targetText(targets) {
    return JSON.stringify(targets.map((target) => ({
      post_uuid: target.post_uuid,
      canonical_url: target.canonical_url
    })));
  }

  function selectCurrentPageTargets(catalog, currentPageSnapshot, options = {}) {
    const maxTargets = Number(options.max_targets ?? PILOT_MAX_TARGETS);
    if (!Number.isSafeInteger(maxTargets) || maxTargets < 1 || maxTargets > FUTURE_BATCH_SIZE) {
      throw new Error("AFFILIATE_CURRENT_PAGE_TARGET_LIMIT_INVALID");
    }
    if (
      !currentPageSnapshot ||
      currentPageSnapshot.source_surface !== "post_search" ||
      !Array.isArray(currentPageSnapshot.posts)
    ) throw new Error("AFFILIATE_CURRENT_PAGE_SNAPSHOT_REQUIRED");
    if (currentPageSnapshot.stop_reason) throw new Error(String(currentPageSnapshot.stop_reason));

    const eligibleTargets = (catalog?.posts || [])
      .map(normalizeTarget)
      .filter(Boolean)
      .sort((left, right) => left.post_uuid.localeCompare(right.post_uuid));
    const eligibleByUuid = new Map();
    for (const target of eligibleTargets) {
      if (eligibleByUuid.has(target.post_uuid)) throw new Error("AFFILIATE_ELIGIBLE_TARGET_IDENTITY_CONFLICT");
      eligibleByUuid.set(target.post_uuid, target);
    }

    const excluded = new Set(
      (options.excluded_post_uuids || []).map((value) => String(value || "").toLowerCase())
    );
    const seen = new Set();
    const candidates = [];
    for (const post of currentPageSnapshot.posts) {
      const identity = parseCanonicalPostUrl(post?.post_public_url);
      if (!identity || identity.post_uuid !== String(post?.post_uuid || "").toLowerCase()) {
        throw new Error("AFFILIATE_CURRENT_PAGE_IDENTITY_INVALID");
      }
      if (seen.has(identity.post_uuid)) throw new Error("AFFILIATE_CURRENT_PAGE_IDENTITY_CONFLICT");
      seen.add(identity.post_uuid);
      const target = eligibleByUuid.get(identity.post_uuid);
      if (target && !excluded.has(identity.post_uuid)) candidates.push(target);
    }

    return {
      targets: candidates.slice(0, maxTargets),
      eligible_target_count: eligibleTargets.length,
      current_page_post_count: currentPageSnapshot.posts.length,
      current_page_candidate_count: candidates.length,
      source_page_url: currentPageSnapshot.source_page_url || null,
      page_fingerprint: currentPageSnapshot.fingerprint || null
    };
  }

  async function freezePilotTargets(catalog, currentPageSnapshot, options = {}) {
    const pilotLimit = Number(options.pilot_limit ?? PILOT_MAX_TARGETS);
    if (!Number.isSafeInteger(pilotLimit) || pilotLimit < 1 || pilotLimit > PILOT_MAX_TARGETS) {
      throw new Error("AFFILIATE_PILOT_LIMIT_INVALID");
    }
    const selected = selectCurrentPageTargets(catalog, currentPageSnapshot, {
      max_targets: pilotLimit
    });
    if (
      options.expected_eligible_count != null &&
      selected.eligible_target_count !== Number(options.expected_eligible_count)
    ) throw new Error("AFFILIATE_ELIGIBLE_TARGET_COUNT_MISMATCH");
    const targets = selected.targets;
    if (targets.length !== pilotLimit) throw new Error("AFFILIATE_PILOT_TARGETS_INSUFFICIENT");
    const targetSetHash = await exportArtifacts.sha256Utf8(targetText(targets));
    if (options.expected_target_hash && targetSetHash !== options.expected_target_hash) {
      throw new Error("AFFILIATE_PILOT_TARGET_ATTESTATION_MISMATCH");
    }
    return {
      targets,
      target_set_hash: targetSetHash,
      eligible_target_count: selected.eligible_target_count,
      pilot_target_count: targets.length,
      current_page_post_count: selected.current_page_post_count,
      current_page_candidate_count: selected.current_page_candidate_count,
      source_page_url: selected.source_page_url,
      page_fingerprint: selected.page_fingerprint
    };
  }

  function summarize(journal) {
    if (!journal) return null;
    return {
      schema_version: journal.schema_version,
      collector_version: journal.collector_version,
      session_id: journal.session_id,
      session_state: journal.session_state,
      stage: journal.stage,
      target_set_hash: journal.target_set_hash,
      total_targets: journal.total_targets,
      eligible_target_count: journal.eligible_target_count,
      current_page_post_count: journal.current_page_post_count,
      current_page_candidate_count: journal.current_page_candidate_count,
      target_source_page_url: journal.target_source_page_url,
      target_page_fingerprint: journal.target_page_fingerprint,
      current_index: journal.current_index,
      completed: journal.completed,
      failed: journal.failed,
      skipped: journal.skipped,
      conflicts: journal.conflicts,
      current_post_uuid_hash: journal.current_post_uuid_hash,
      checkpoint: journal.checkpoint,
      started_at: journal.started_at,
      updated_at: journal.updated_at,
      stop_reason: journal.stop_reason,
      failure_reason: journal.failure_reason,
      next_allowed_at: journal.next_allowed_at,
      result_deadline: journal.result_deadline,
      observed_url_shape: clone(journal.observed_url_shape),
      generation_surface: journal.generation_surface || null
    };
  }

  function terminal(journal) {
    return Boolean(journal && journal.session_state !== SESSION_STATES.RUNNING);
  }

  function classifyVisibleResult(input) {
    const visibleText = String(input?.visible_text || "");
    const urls = [...new Set((input?.visible_urls || []).map(parseAffiliateUrl).filter(Boolean))];
    if (/(?:CAPTCHA|reCAPTCHA|bot verification|不正なアクセス)/iu.test(visibleText)) {
      return { status: "STOP", reason: "CAPTCHA_OR_ANTI_BOT_DETECTED" };
    }
    if (/(?:Too Many Requests|アクセスが集中|リクエストが多すぎ|しばらく時間をおいて)/iu.test(visibleText)) {
      return { status: "STOP", reason: "RATE_LIMIT_DETECTED" };
    }
    if (input?.has_login_form || /(?:ログイン|サインイン)してください/iu.test(visibleText)) {
      return { status: "STOP", reason: "LOGIN_CHALLENGE_DETECTED" };
    }
    if (/(?:対象外|生成できません|利用できません|許可されていません)/u.test(visibleText)) {
      return { status: "STOP", reason: "AFFILIATE_TARGET_INELIGIBLE" };
    }
    if (urls.length > 1) return { status: "CONFLICT", reason: "MULTIPLE_AFFILIATE_URLS_VISIBLE" };
    if (urls.length === 1) {
      return {
        status: "SUCCESS",
        affiliate_url: urls[0],
        shape: affiliateUrlShape(urls[0])
      };
    }
    if (input?.copy_success_visible || /(?:コピーしました|クリップボードにコピー)/u.test(visibleText)) {
      return { status: "BLOCKED", reason: "AUTOMATION_BLOCKED_BY_CLIPBOARD_ONLY_UI" };
    }
    if (/(?:入力してください|URL.+正しく|無効なURL|形式が正しく)/u.test(visibleText)) {
      return { status: "STOP", reason: "GENERATION_VALIDATION_ERROR" };
    }
    return { status: "PENDING", reason: null };
  }

  function classifyGenerationUiAudit(input) {
    if (input?.authenticated_affiliate_scope !== true) {
      return { ready: false, reason: "AUTHENTICATED_AFFILIATE_CENTER_SCOPE_REQUIRED" };
    }

    if (Number(input?.target_card_count) > 0) {
      if (input.target_card_count !== 1) {
        return { ready: false, reason: "AFFILIATE_TARGET_CARD_AMBIGUOUS" };
      }
      if (input.target_card_post_identity_count !== 1) {
        return { ready: false, reason: "AFFILIATE_TARGET_CARD_IDENTITY_AMBIGUOUS" };
      }
      if (input.target_card_action_count !== 1) {
        return { ready: false, reason: "OFFICIAL_CARD_GENERATION_CONTROL_NOT_UNIQUE" };
      }
      return {
        ready: true,
        reason: null,
        surface_kind: GENERATION_SURFACES.SEARCH_RESULT_CARD
      };
    }

    if (Number(input?.target_identity_count) > 0 || Number(input?.target_card_action_count) > 0) {
      return { ready: false, reason: "AFFILIATE_TARGET_CARD_NOT_UNIQUE" };
    }
    if (input?.route && input?.input_count === 1 && input?.generate_control_count === 1) {
      return {
        ready: true,
        reason: null,
        surface_kind: GENERATION_SURFACES.DEDICATED_FORM
      };
    }
    if (input?.route && input?.input_count !== 1) {
      return { ready: false, reason: "OFFICIAL_GENERATION_INPUT_NOT_UNIQUE" };
    }
    if (input?.route && input?.generate_control_count !== 1) {
      return { ready: false, reason: "OFFICIAL_GENERATE_CONTROL_NOT_UNIQUE" };
    }
    return { ready: false, reason: "OFFICIAL_AFFILIATE_GENERATION_CAPABILITY_NOT_FOUND" };
  }

  function classifyJournalResult(journal, result) {
    const filteredResult = {
      ...result,
      visible_urls: (result?.visible_urls || []).filter((url) =>
        !(journal.pre_dispatch_visible_urls || []).includes(parseAffiliateUrl(url))
      )
    };
    if (
      filteredResult.visible_urls.length === 0 &&
      filteredResult.copy_success_visible &&
      journal.pre_dispatch_copy_success_visible === true &&
      filteredResult.structural_fingerprint === journal.pre_dispatch_structural_fingerprint
    ) {
      filteredResult.copy_success_visible = false;
      filteredResult.visible_text = String(filteredResult.visible_text || "")
        .replace(/(?:コピーしました|クリップボードにコピー)/gu, "");
    }
    return classifyVisibleResult(filteredResult);
  }

  function createAffiliateGenerationOrchestrator(adapters) {
    if (
      !adapters?.storage ||
      !adapters?.get_catalog ||
      !adapters?.get_current_page ||
      !adapters?.prepare_target ||
      !adapters?.dispatch_generation
    ) {
      throw new Error("AFFILIATE_GENERATION_ADAPTERS_INVALID");
    }
    const inFlight = new Map();

    async function readJournal() {
      const stored = await adapters.storage.get([ACTIVE_SESSION_KEY, LAST_SESSION_KEY]);
      return {
        active: stored?.[ACTIVE_SESSION_KEY] || null,
        last: stored?.[LAST_SESSION_KEY] || null
      };
    }

    async function writeJournal(journal) {
      await adapters.storage.set({ [ACTIVE_SESSION_KEY]: journal });
      return journal;
    }

    function patch(journal, values) {
      return {
        ...journal,
        ...values,
        revision: journal.revision + 1,
        updated_at: isoNow(adapters)
      };
    }

    async function postUuidHash(target) {
      return exportArtifacts.sha256Utf8(target.post_uuid);
    }

    async function start(input) {
      if (!input?.session_id || !Number.isInteger(input.tab_id)) throw new Error("AFFILIATE_SESSION_IDENTITY_INVALID");
      const prior = await readJournal();
      if (prior.active && !terminal(prior.active)) throw new Error("DUPLICATE_AFFILIATE_SESSION");
      const catalogContext = await adapters.get_catalog(input.tab_id);
      const currentPageContext = await adapters.get_current_page(input.tab_id, catalogContext.scope_key);
      if (!currentPageContext || currentPageContext.scope_key !== catalogContext.scope_key) {
        throw new Error("AFFILIATE_CURRENT_PAGE_SCOPE_MISMATCH");
      }
      const frozen = await freezePilotTargets(catalogContext.catalog, currentPageContext.snapshot, {
        pilot_limit: input.pilot_limit,
        expected_target_hash: input.expected_target_hash,
        expected_eligible_count: input.expected_eligible_count
      });
      const timestamp = isoNow(adapters);
      const first = frozen.targets[0];
      const journal = {
        schema_version: SESSION_SCHEMA_VERSION,
        collector_version: input.collector_version,
        session_id: input.session_id,
        tab_id: input.tab_id,
        scope_key: catalogContext.scope_key,
        session_state: SESSION_STATES.RUNNING,
        stage: SESSION_STAGES.PREPARING_TARGET,
        revision: 1,
        target_set_hash: frozen.target_set_hash,
        eligible_target_count: frozen.eligible_target_count,
        current_page_post_count: frozen.current_page_post_count,
        current_page_candidate_count: frozen.current_page_candidate_count,
        target_source_page_url: frozen.source_page_url,
        target_page_fingerprint: frozen.page_fingerprint,
        total_targets: frozen.pilot_target_count,
        targets: frozen.targets,
        current_index: 0,
        current_post_uuid: first.post_uuid,
        current_post_uuid_hash: await postUuidHash(first),
        current_canonical_url: first.canonical_url,
        completed: 0,
        failed: 0,
        skipped: 0,
        conflicts: 0,
        checkpoint: 0,
        observations: [],
        observed_url_shape: null,
        generation_surface: null,
        pre_dispatch_visible_urls: [],
        pre_dispatch_copy_success_visible: false,
        pre_dispatch_structural_fingerprint: null,
        dispatch_nonce: null,
        generation_dispatched_at: null,
        result_deadline: null,
        next_allowed_at: null,
        started_at: timestamp,
        updated_at: timestamp,
        stop_reason: null,
        failure_reason: null
      };
      const update = { [ACTIVE_SESSION_KEY]: journal };
      if (prior.active) update[LAST_SESSION_KEY] = summarize(prior.active);
      await adapters.storage.set(update);
      return summarize(journal);
    }

    async function fail(journal, reason, state = SESSION_STATES.FAILED) {
      return writeJournal(patch(journal, {
        session_state: state,
        stage: state === SESSION_STATES.PAUSED_REQUIRES_RECOVERY
          ? SESSION_STAGES.PAUSED_REQUIRES_RECOVERY
          : SESSION_STAGES.FAILED,
        failed: journal.failed + 1,
        stop_reason: reason,
        failure_reason: reason
      }));
    }

    async function completeResult(journal, classified) {
      const target = journal.targets[journal.current_index];
      if (!target || target.post_uuid !== journal.current_post_uuid) {
        return fail(journal, "AFFILIATE_TARGET_JOURNAL_MISMATCH");
      }
      if (journal.observed_url_shape && JSON.stringify(journal.observed_url_shape) !== JSON.stringify(classified.shape)) {
        return fail({ ...journal, conflicts: journal.conflicts + 1 }, "AFFILIATE_URL_SHAPE_CONFLICT");
      }
      if (journal.observations.some((item) =>
        item.post_uuid !== target.post_uuid && item.affiliate_url === classified.affiliate_url
      )) return fail({ ...journal, conflicts: journal.conflicts + 1 }, "AFFILIATE_URL_REUSED_ACROSS_POSTS");
      const now = isoNow(adapters);
      const observation = {
        post_uuid: target.post_uuid,
        canonical_url: target.canonical_url,
        affiliate_url: classified.affiliate_url,
        affiliate_link_status: "ACTIVE",
        first_seen_at: now,
        last_seen_at: now,
        source_surface: journal.generation_surface === GENERATION_SURFACES.SEARCH_RESULT_CARD
          ? "affiliate_search_result_card"
          : "official_generation_ui",
        generation_session_id: journal.session_id
      };
      observation.affiliate_url_hash = await exportArtifacts.sha256Utf8(observation.affiliate_url);
      const nextIndex = journal.current_index + 1;
      const completed = journal.completed + 1;
      let next = patch(journal, {
        observations: [...journal.observations, observation],
        observed_url_shape: journal.observed_url_shape || classified.shape,
        completed,
        checkpoint: completed,
        current_index: nextIndex,
        stage: nextIndex >= journal.total_targets ? SESSION_STAGES.PILOT_COMPLETED : SESSION_STAGES.COOLDOWN,
        session_state: nextIndex >= journal.total_targets ? SESSION_STATES.PILOT_COMPLETED : SESSION_STATES.RUNNING,
        stop_reason: nextIndex >= journal.total_targets ? "PILOT_LIMIT_REACHED" : null,
        next_allowed_at: nextIndex >= journal.total_targets
          ? null
          : new Date(adapters.now() + GENERATION_COOLDOWN_MS).toISOString(),
        dispatch_nonce: null,
        generation_dispatched_at: null,
        result_deadline: null,
        current_post_uuid: nextIndex >= journal.total_targets ? null : journal.targets[nextIndex].post_uuid,
        current_post_uuid_hash: nextIndex >= journal.total_targets
          ? null
          : await postUuidHash(journal.targets[nextIndex]),
        current_canonical_url: nextIndex >= journal.total_targets ? null : journal.targets[nextIndex].canonical_url
      });
      next = await adapters.commit_result(journal, next, observation);
      if (next.session_state === SESSION_STATES.RUNNING && next.next_allowed_at) {
        await adapters.schedule_recovery(
          next.session_id,
          Math.max(0, Date.parse(next.next_allowed_at) - adapters.now())
        );
      }
      return next;
    }

    async function handleResult(input) {
      const { active } = await readJournal();
      if (!active || active.session_id !== input?.session_id) throw new Error("AFFILIATE_SESSION_NOT_FOUND");
      if (active.stage !== SESSION_STAGES.WAITING_FOR_RESULT) return summarize(active);
      if (input.dispatch_nonce !== active.dispatch_nonce) throw new Error("AFFILIATE_DISPATCH_NONCE_MISMATCH");
      const classified = classifyJournalResult(active, input.result);
      if (classified.status === "PENDING") return summarize(active);
      if (classified.status === "SUCCESS") return summarize(await completeResult(active, classified));
      const state = classified.status === "BLOCKED"
        ? SESSION_STATES.PAUSED_REQUIRES_RECOVERY
        : SESSION_STATES.FAILED;
      return summarize(await fail(active, classified.reason, state));
    }

    async function recover(tabId) {
      const { active } = await readJournal();
      if (!active || terminal(active)) return summarize(active);
      if (tabId != null && active.tab_id !== tabId) return summarize(active);
      if (inFlight.has(active.session_id)) return inFlight.get(active.session_id);
      const task = (async () => {
        let journal = (await readJournal()).active;
        if (!journal || terminal(journal)) return summarize(journal);
        if (journal.stage === SESSION_STAGES.COOLDOWN) {
          if (Date.parse(journal.next_allowed_at || "") > adapters.now()) {
            await adapters.schedule_recovery(journal.session_id, Date.parse(journal.next_allowed_at) - adapters.now());
            return summarize(journal);
          }
          journal = await writeJournal(patch(journal, {
            stage: SESSION_STAGES.PREPARING_TARGET,
            next_allowed_at: null
          }));
        }
        if (journal.stage === SESSION_STAGES.PREPARING_TARGET) {
          const target = journal.targets[journal.current_index];
          const prepared = await adapters.prepare_target(journal.tab_id, {
            session_id: journal.session_id,
            post_uuid: target.post_uuid,
            canonical_url: target.canonical_url
          });
          if (!prepared?.ready) return summarize(await fail(journal, prepared?.reason || "AFFILIATE_GENERATION_UI_NOT_READY", SESSION_STATES.PAUSED_REQUIRES_RECOVERY));
          journal = await writeJournal(patch(journal, {
            stage: SESSION_STAGES.READY_TO_DISPATCH,
            dispatch_nonce: adapters.uuid(),
            generation_surface: prepared.surface_kind || null,
            pre_dispatch_visible_urls: [...new Set(
              (prepared.baseline_visible_urls || []).map(parseAffiliateUrl).filter(Boolean)
            )],
            pre_dispatch_copy_success_visible: prepared.baseline_copy_success_visible === true,
            pre_dispatch_structural_fingerprint: prepared.baseline_structural_fingerprint || null
          }));
        }
        if (journal.stage === SESSION_STAGES.READY_TO_DISPATCH) {
          const deadline = new Date(adapters.now() + RESULT_TIMEOUT_MS).toISOString();
          journal = await writeJournal(patch(journal, {
            stage: SESSION_STAGES.WAITING_FOR_RESULT,
            generation_dispatched_at: isoNow(adapters),
            result_deadline: deadline
          }));
          await adapters.dispatch_generation(journal.tab_id, {
            session_id: journal.session_id,
            dispatch_nonce: journal.dispatch_nonce,
            post_uuid: journal.current_post_uuid,
            canonical_url: journal.current_canonical_url
          });
          await adapters.schedule_recovery(journal.session_id, RESULT_TIMEOUT_MS);
          return summarize(journal);
        }
        if (journal.stage === SESSION_STAGES.WAITING_FOR_RESULT) {
          const inspected = await adapters.inspect_result(journal.tab_id, {
            session_id: journal.session_id,
            dispatch_nonce: journal.dispatch_nonce,
            post_uuid: journal.current_post_uuid
          });
          const classified = classifyJournalResult(journal, inspected);
          if (classified.status === "SUCCESS") return summarize(await completeResult(journal, classified));
          if (classified.status !== "PENDING") {
            const state = classified.status === "BLOCKED"
              ? SESSION_STATES.PAUSED_REQUIRES_RECOVERY
              : SESSION_STATES.FAILED;
            return summarize(await fail(journal, classified.reason, state));
          }
          if (Date.parse(journal.result_deadline || "") <= adapters.now()) {
            return summarize(await fail(journal, "GENERATION_RESULT_TIMEOUT", SESSION_STATES.PAUSED_REQUIRES_RECOVERY));
          }
        }
        return summarize(journal);
      })().catch(async (error) => {
        const latest = (await readJournal()).active;
        if (!latest || terminal(latest)) return summarize(latest);
        return summarize(await fail(
          latest,
          String(error?.message || "AFFILIATE_GENERATION_STAGE_FAILED"),
          SESSION_STATES.PAUSED_REQUIRES_RECOVERY
        ));
      }).finally(() => inFlight.delete(active.session_id));
      inFlight.set(active.session_id, task);
      return task;
    }

    async function cancel(sessionId) {
      const { active } = await readJournal();
      if (!active || active.session_id !== sessionId) throw new Error("AFFILIATE_SESSION_NOT_FOUND");
      if (terminal(active)) return summarize(active);
      if (active.stage === SESSION_STAGES.WAITING_FOR_RESULT) {
        throw new Error("AFFILIATE_GENERATION_ALREADY_DISPATCHED");
      }
      return summarize(await writeJournal(patch(active, {
        session_state: SESSION_STATES.CANCELLED,
        stage: SESSION_STAGES.CANCELLED,
        stop_reason: "USER_CANCELLED"
      })));
    }

    async function getStatus() {
      const state = await readJournal();
      return { active: summarize(state.active), last: clone(state.last) };
    }

    return { cancel, getStatus, handleResult, readJournal, recover, start };
  }

  global.MyFansAffiliateGenerationCore = Object.freeze({
    ACTIVE_SESSION_KEY,
    FUTURE_BATCH_SIZE,
    GENERATION_COOLDOWN_MS,
    GENERATION_ROUTES,
    GENERATION_SURFACES,
    LAST_SESSION_KEY,
    PILOT_MAX_TARGETS,
    RESULT_TIMEOUT_MS,
    SESSION_SCHEMA_VERSION,
    SESSION_STAGES,
    SESSION_STATES,
    affiliateUrlShape,
    classifyVisibleResult,
    classifyGenerationUiAudit,
    createAffiliateGenerationOrchestrator,
    freezePilotTargets,
    generationRoute,
    parseAffiliateUrl,
    parseCanonicalPostUrl,
    selectCurrentPageTargets,
    summarize,
    targetText,
    terminal
  });
})(globalThis);
