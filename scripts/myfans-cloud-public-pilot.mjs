#!/usr/bin/env node
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  MYFANS_ACCESS,
  MYFANS_CLASSIFICATIONS,
  MYFANS_ORIGIN,
  MYFANS_PARSER_VERSION,
  assertFrozenSafeRecords,
  assertNoRawHtmlPersisted,
  dedupeFrozenRecords,
  detectPublicPageAccess,
  discoverCreatorCandidatesFromRanking,
  discoverPublicLinks,
  creatorSlugFromUrl,
  metadataHash,
  parseCreatorPage,
  parsePostPage,
  postIdFromUrl,
  readFrozenJsonlGzip,
  writeFrozenJsonlGzip,
  writeJson,
} from "./lib/myfans-public-metadata.mjs";
import {
  MODERN_BROWSER_SOURCE_TYPE,
  createModernBrowserRenderer,
  probeModernBrowserEnvironment,
} from "./lib/myfans-modern-browser-renderer.mjs";

export const CLOUD_ARTIFACT_FILES = Object.freeze([
  "browser-environment.json",
  "classification-summary.json",
  "creator-candidates.json",
  "discovery-candidates.json",
  "exact-link-candidates.json",
  "frozen-summary.json",
  "myfans-public-pilot.jsonl.gz",
  "post-candidates.json",
  "rendered-ranking-observation.json",
  "request-summary.json",
  "safe-creators.json",
  "safe-posts.json",
]);

const CREATOR_RANKING_URL = `${MYFANS_ORIGIN}/ranking/creators/all?term=daily`;
const POST_RANKING_URL = `${MYFANS_ORIGIN}/ranking/posts/all?term=daily`;
const NEUTRAL_URL = "https://example.com/";
const MAX_CREATORS = 5;
const MAX_POSTS = 30;

function phaseRecord() {
  const start = new Date().toISOString();
  return { start, end: null, elapsed_sec: null };
}

function endPhase(record) {
  record.end = new Date().toISOString();
  record.elapsed_sec = Number(((Date.parse(record.end) - Date.parse(record.start)) / 1000).toFixed(3));
}

function classificationCounts(records) {
  return Object.fromEntries(Object.values(MYFANS_CLASSIFICATIONS).map((classification) => [
    classification,
    records.filter((record) => record.classification === classification).length,
  ]));
}

function frozenHashes(records) {
  const membership = records.map((record) => `${record.entity_type}:${record.external_id ?? "missing"}`).sort();
  const manifest = records.map((record) => ({
    entity_type: record.entity_type,
    external_id: record.external_id,
    metadata_hash: record.metadata_hash,
    source_page_hash: record.source_page_hash,
    classification: record.classification,
  })).sort((left, right) => `${left.entity_type}:${left.external_id}`.localeCompare(`${right.entity_type}:${right.external_id}`));
  return {
    membership_sha256: metadataHash(membership),
    manifest_sha256: metadataHash(manifest),
    payload_sha256: metadataHash(records),
  };
}

function roundRobin(groups, limit) {
  const queues = groups.map((group) => [...group]);
  const result = [];
  const seen = new Set();
  while (result.length < limit && queues.some((queue) => queue.length)) {
    for (const queue of queues) {
      const value = queue.shift();
      if (value && !seen.has(value)) {
        seen.add(value);
        result.push(value);
        if (result.length >= limit) break;
      }
    }
  }
  return result;
}

function modernRecord(record, discoveryMethod) {
  return {
    ...record,
    source_type: MODERN_BROWSER_SOURCE_TYPE,
    discovery_method: discoveryMethod,
  };
}

function errorOutcome(error) {
  if (error?.code === "MODERN_BROWSER_RUNNER_UNAVAILABLE") return "PHASE6C_MODERN_BROWSER_RUNNER_UNAVAILABLE";
  if (/CERTIFICATE|CHALLENGE|AUTH_SESSION|PROTECTED_INTERSTITIAL|HTTP_403|HTTP_429/.test(error?.code ?? "")) return "PHASE6C_MYFANS_SECURITY_FAILED";
  return "PHASE6C_CLOUD_BROWSER_RUNNER_FAILED";
}

async function persistArtifacts({
  outputDir,
  environment,
  outcome,
  errorCode,
  discoveryCandidates,
  creators,
  posts,
  rankingObservation,
  transportSummary,
  postDetailVerified,
  cloudTiming,
}) {
  const records = dedupeFrozenRecords([...creators, ...posts]);
  assertNoRawHtmlPersisted(records);
  assertFrozenSafeRecords(records);
  const safeCreators = records.filter((record) => record.entity_type === "creator" && record.classification === MYFANS_CLASSIFICATIONS.SAFE);
  const safePosts = records.filter((record) => record.entity_type === "post" && record.classification === MYFANS_CLASSIFICATIONS.SAFE);
  const hashes = frozenHashes(records);
  const generatedAt = new Date().toISOString();
  const requestSummary = {
    generated_at: generatedAt,
    outcome,
    request_budget: 38,
    browser_navigation: transportSummary.actual_requests ?? 0,
    neutral_navigation: transportSummary.requests?.filter((entry) => entry.label === "neutral").length ?? 0,
    creator_ranking_navigation: transportSummary.requests?.filter((entry) => entry.label === "creator_ranking").length ?? 0,
    creator_profile_navigation: transportSummary.requests?.filter((entry) => entry.label?.startsWith("creator:")).length ?? 0,
    post_ranking_navigation: transportSummary.requests?.filter((entry) => entry.label === "post_ranking").length ?? 0,
    post_detail_navigation: transportSummary.requests?.filter((entry) => entry.label?.startsWith("post:")).length ?? 0,
    retry: 0,
    duplicate: 0,
    intentional_image: 0,
    intentional_video: 0,
    intentional_audio: 0,
    authenticated: 0,
    private_api: 0,
    browser_generated_request_types: transportSummary.browser_generated_request_types ?? {},
    cloud_timing: cloudTiming,
    requests: transportSummary.requests ?? [],
  };
  const frozenSummary = {
    generated_at: generatedAt,
    outcome,
    parser_version: MYFANS_PARSER_VERSION,
    source_type: MODERN_BROWSER_SOURCE_TYPE,
    record_count: records.length,
    ...hashes,
    creators: creators.length,
    posts: posts.length,
    safe_creators: safeCreators.length,
    safe_posts: safePosts.length,
    post_detail_verified: postDetailVerified,
    hash_contract: "SHA256_STABLE_JSON",
    raw_html_stored: 0,
    raw_dom_stored: 0,
    screenshots_stored: 0,
    image_bodies_stored: 0,
    video_bodies_stored: 0,
    audio_bodies_stored: 0,
    apply: false,
  };
  const classificationSummary = {
    generated_at: generatedAt,
    outcome,
    error_code: errorCode,
    creator: classificationCounts(records.filter((record) => record.entity_type === "creator")),
    post: classificationCounts(records.filter((record) => record.entity_type === "post")),
    post_detail_verified: postDetailVerified,
    staging_attempted: false,
  };
  const common = { generated_at: generatedAt, outcome, apply: false };
  await Promise.all([
    writeJson(path.join(outputDir, "browser-environment.json"), {
      ...environment,
      generated_at: generatedAt,
      outcome,
      github_run_id: process.env.GITHUB_RUN_ID ?? null,
      github_run_attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      github_sha: process.env.GITHUB_SHA ?? null,
      workflow_auth_secrets: 0,
      production_secrets: 0,
      cleanup: transportSummary.cleanup ?? null,
    }),
    writeJson(path.join(outputDir, "rendered-ranking-observation.json"), {
      generated_at: generatedAt,
      outcome,
      ...rankingObservation,
      raw_html_persisted: false,
      raw_dom_persisted: false,
      screenshot_persisted: false,
    }),
    writeJson(path.join(outputDir, "discovery-candidates.json"), { ...common, records: discoveryCandidates }),
    writeJson(path.join(outputDir, "creator-candidates.json"), { ...common, records: creators }),
    writeJson(path.join(outputDir, "post-candidates.json"), { ...common, records: posts }),
    writeJson(path.join(outputDir, "safe-creators.json"), { ...common, records: safeCreators }),
    writeJson(path.join(outputDir, "safe-posts.json"), { ...common, records: safePosts }),
    writeJson(path.join(outputDir, "frozen-summary.json"), frozenSummary),
    writeJson(path.join(outputDir, "classification-summary.json"), classificationSummary),
    writeJson(path.join(outputDir, "request-summary.json"), requestSummary),
    writeJson(path.join(outputDir, "exact-link-candidates.json"), { ...common, records: [] }),
    writeFrozenJsonlGzip(path.join(outputDir, "myfans-public-pilot.jsonl.gz"), records),
  ]);
  return { records, safeCreators, safePosts, frozenSummary, requestSummary };
}

export async function validateCloudArtifactDirectory(directory) {
  const names = (await readdir(directory)).sort();
  const expected = [...CLOUD_ARTIFACT_FILES].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error("CLOUD_ARTIFACT_FILE_ALLOWLIST_FAILED");
  let totalBytes = 0;
  for (const name of names) {
    const info = await stat(path.join(directory, name));
    if (!info.isFile()) throw new Error("CLOUD_ARTIFACT_NON_FILE_ENTRY");
    totalBytes += info.size;
  }
  if (totalBytes > 5_000_000) throw new Error("CLOUD_ARTIFACT_SIZE_LIMIT_EXCEEDED");
  const jsonNames = names.filter((name) => name.endsWith(".json"));
  const jsonValues = {};
  for (const name of jsonNames) jsonValues[name] = JSON.parse(await readFile(path.join(directory, name), "utf8"));
  const records = await readFrozenJsonlGzip(path.join(directory, "myfans-public-pilot.jsonl.gz"));
  assertNoRawHtmlPersisted(jsonValues);
  assertNoRawHtmlPersisted(records);
  assertFrozenSafeRecords(records);
  const serialized = JSON.stringify({ jsonValues, records });
  if (/(?:ghp_|github_pat_|SUPABASE_(?:URL|KEY)|VERCEL_TOKEN|postgres(?:ql)?:\/\/)/i.test(serialized)) throw new Error("CLOUD_ARTIFACT_SECRET_PATTERN_DETECTED");
  if (/\.(?:jpe?g|png|gif|webp|avif|mp4|webm|m3u8|mov|mp3|wav)"/i.test(JSON.stringify(names))) throw new Error("CLOUD_ARTIFACT_MEDIA_FILE_DETECTED");
  for (const record of records) {
    if (record.source_type !== MODERN_BROWSER_SOURCE_TYPE) throw new Error("CLOUD_ARTIFACT_SOURCE_TYPE_INVALID");
    if (record.parser_version !== MYFANS_PARSER_VERSION) throw new Error("CLOUD_ARTIFACT_PARSER_VERSION_INVALID");
    if (record.metadata_hash !== metadataHash(record.raw_public_metadata)) throw new Error("CLOUD_ARTIFACT_METADATA_HASH_INVALID");
    if (!/^[0-9a-f]{64}$/.test(record.source_page_hash ?? "")) throw new Error("CLOUD_ARTIFACT_SOURCE_HASH_INVALID");
  }
  const safeCreators = records.filter((record) => record.entity_type === "creator" && record.classification === MYFANS_CLASSIFICATIONS.SAFE);
  const safePosts = records.filter((record) => record.entity_type === "post" && record.classification === MYFANS_CLASSIFICATIONS.SAFE);
  const safeCreatorIds = new Set(safeCreators.map((record) => record.external_id));
  for (const creator of safeCreators) {
    if (creatorSlugFromUrl(creator.official_url) !== creator.external_id) throw new Error("CLOUD_ARTIFACT_CREATOR_IDENTITY_INVALID");
    if (!creator.discovery_evidence?.some((evidence) => /^RANKING_CREATOR_ITEM_/.test(evidence))) throw new Error("CLOUD_ARTIFACT_CREATOR_DISCOVERY_INVALID");
    if (creator.visibility !== "public" || creator.access_classification !== MYFANS_ACCESS.PUBLIC) throw new Error("CLOUD_ARTIFACT_CREATOR_ACCESS_INVALID");
  }
  for (const post of safePosts) {
    if (postIdFromUrl(post.official_url) !== post.external_id || !safeCreatorIds.has(post.creator_external_id)) throw new Error("CLOUD_ARTIFACT_POST_IDENTITY_INVALID");
    if (post.visibility !== "public" || post.access_classification !== MYFANS_ACCESS.PUBLIC) throw new Error("CLOUD_ARTIFACT_POST_ACCESS_INVALID");
  }
  const frozen = jsonValues["frozen-summary.json"];
  const hashes = frozenHashes(records);
  for (const [name, value] of Object.entries(hashes)) {
    if (frozen[name] !== value || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`CLOUD_ARTIFACT_${name.toUpperCase()}_INVALID`);
  }
  if (frozen.record_count !== records.length) throw new Error("CLOUD_ARTIFACT_RECORD_COUNT_INVALID");
  if (frozen.safe_creators !== safeCreators.length || frozen.safe_posts !== safePosts.length) throw new Error("CLOUD_ARTIFACT_SAFE_COUNT_INVALID");
  if (metadataHash(jsonValues["safe-creators.json"].records) !== metadataHash(safeCreators)) throw new Error("CLOUD_ARTIFACT_SAFE_CREATOR_SET_INVALID");
  if (metadataHash(jsonValues["safe-posts.json"].records) !== metadataHash(safePosts)) throw new Error("CLOUD_ARTIFACT_SAFE_POST_SET_INVALID");
  return {
    valid: true,
    file_count: names.length,
    total_bytes: totalBytes,
    record_count: records.length,
    ...hashes,
    raw_html: 0,
    raw_dom: 0,
    media_files: 0,
    secret_patterns: 0,
  };
}

export async function runCloudPilot({
  outputDir,
  environmentProbe = probeModernBrowserEnvironment,
  rendererFactory = createModernBrowserRenderer,
} = {}) {
  if (!outputDir) throw new Error("OUTPUT_DIRECTORY_REQUIRED");
  const cloudTiming = { environment: phaseRecord() };
  const environment = await environmentProbe();
  endPhase(cloudTiming.environment);
  const discoveryCandidates = [];
  const creators = [];
  const posts = [];
  const postUrlMethods = new Map();
  let rankingObservation = {
    status: "NOT_RUN",
    url: CREATOR_RANKING_URL,
    title: null,
    final_url: null,
    dom_bytes: null,
    text_length: null,
    anchor_count: null,
    creator_structure_count: 0,
    rank_like_content: false,
  };
  let renderer = null;
  let transportSummary = { actual_requests: 0, requests: [], cleanup: null };
  let outcome = null;
  let errorCode = null;
  let postDetailVerified = false;
  try {
    if (!environment.modern_browser_available) {
      const error = new Error("MODERN_BROWSER_RUNNER_UNAVAILABLE");
      error.code = "MODERN_BROWSER_RUNNER_UNAVAILABLE";
      throw error;
    }
    renderer = rendererFactory({ browser: environment, maxNavigations: 38, maxWaitMs: 15_000 });
    await renderer.start();

    cloudTiming.neutral = phaseRecord();
    const neutral = await renderer.render(NEUTRAL_URL, { label: "neutral" });
    endPhase(cloudTiming.neutral);
    if (neutral.render_observation.title !== "Example Domain") throw new Error("NEUTRAL_BROWSER_GATE_FAILED");

    cloudTiming.creator_ranking = phaseRecord();
    const ranking = await renderer.render(CREATOR_RANKING_URL, { label: "creator_ranking" });
    endPhase(cloudTiming.creator_ranking);
    const rankingAccess = detectPublicPageAccess(ranking);
    rankingObservation = {
      status: rankingAccess.access === MYFANS_ACCESS.PUBLIC ? "RENDERED_PUBLIC_DOM" : rankingAccess.access,
      url: CREATOR_RANKING_URL,
      title: ranking.render_observation.title,
      final_url: ranking.render_observation.href,
      ready_state: ranking.render_observation.ready_state,
      dom_bytes: ranking.render_observation.dom_length,
      text_length: ranking.render_observation.text_length,
      anchor_count: ranking.render_observation.anchor_count,
      rank_like_content: ranking.render_observation.rank_like_content,
      ranking_related: ranking.render_observation.ranking_related,
      creator_structure_count: ranking.rendered_units.length,
      certificate_warning: false,
      authenticated_session_present: false,
      challenge: false,
    };
    if (rankingAccess.access !== MYFANS_ACCESS.PUBLIC) throw new Error("MYFANS_RANKING_ACCESS_NOT_PUBLIC");
    if (ranking.rendered_units.length === 0) {
      outcome = "PHASE6C_MYFANS_PUBLIC_RANKING_NOT_AUTOMATABLE";
    } else {
      discoveryCandidates.push(...discoverCreatorCandidatesFromRanking(ranking.html, ranking.url, {
        renderedUnits: ranking.rendered_units,
        renderedSource: "modern_browser",
        includeGenericAnchors: false,
      }));
      const accepted = discoveryCandidates.filter((candidate) => !candidate.rejected_reason).slice(0, MAX_CREATORS);
      if (!accepted.length) {
        outcome = "PHASE6C_MYFANS_RENDERED_PARSER_FAILED";
      } else {
        cloudTiming.creator = phaseRecord();
        const postGroups = [];
        for (const [index, candidate] of accepted.entries()) {
          const response = await renderer.render(candidate.url, { label: `creator:${index + 1}` });
          candidate.fetched = true;
          const record = modernRecord(parseCreatorPage({
            html: response.html,
            sourceUrl: candidate.url,
            discoveryEvidence: candidate.positive_discovery_evidence,
            fetchedAt: response.fetched_at,
            status: response.status,
            location: response.location,
          }), candidate.discovery_method);
          creators.push(record);
          const urls = response.status === 200 ? discoverPublicLinks(response.html, response.url).post_urls : [];
          for (const url of urls) postUrlMethods.set(url, "safe_creator_profile");
          postGroups.push(urls);
        }
        endPhase(cloudTiming.creator);
        const safeCreatorIds = creators.filter((record) => record.classification === MYFANS_CLASSIFICATIONS.SAFE).map((record) => record.external_id);
        if (!safeCreatorIds.length) {
          outcome = "PHASE6C_MYFANS_RENDERED_PARSER_FAILED";
        } else {
          if (!postGroups.some((group) => group.length)) {
            cloudTiming.post_ranking = phaseRecord();
            const response = await renderer.render(POST_RANKING_URL, { label: "post_ranking" });
            endPhase(cloudTiming.post_ranking);
            const accessResult = detectPublicPageAccess(response);
            const urls = accessResult.access === MYFANS_ACCESS.PUBLIC ? discoverPublicLinks(response.html, response.url).post_urls : [];
            for (const url of urls) postUrlMethods.set(url, "public_post_ranking");
            postGroups.push(urls);
          }
          const postUrls = roundRobin(postGroups, MAX_POSTS);
          if (!postUrls.length) {
            outcome = "PHASE6C_MYFANS_CREATOR_ONLY_READY";
          } else {
            cloudTiming.post_gate = phaseRecord();
            const gateResponse = await renderer.render(postUrls[0], { label: "post:gate" });
            const gate = modernRecord(parsePostPage({
              html: gateResponse.html,
              sourceUrl: postUrls[0],
              knownCreatorExternalIds: safeCreatorIds,
              fetchedAt: gateResponse.fetched_at,
              status: gateResponse.status,
              location: gateResponse.location,
            }), postUrlMethods.get(postUrls[0]) ?? "public_post_route");
            posts.push(gate);
            postDetailVerified = gate.classification === MYFANS_CLASSIFICATIONS.SAFE;
            endPhase(cloudTiming.post_gate);
            if (!postDetailVerified) {
              outcome = "PHASE6C_MYFANS_CREATOR_ONLY_READY";
            } else {
              cloudTiming.post = phaseRecord();
              for (const [index, postUrl] of postUrls.slice(1).entries()) {
                const response = await renderer.render(postUrl, { label: `post:${index + 2}` });
                posts.push(modernRecord(parsePostPage({
                  html: response.html,
                  sourceUrl: postUrl,
                  knownCreatorExternalIds: safeCreatorIds,
                  fetchedAt: response.fetched_at,
                  status: response.status,
                  location: response.location,
                }), postUrlMethods.get(postUrl) ?? "public_post_route"));
              }
              endPhase(cloudTiming.post);
              outcome = "PHASE6C_MYFANS_MODERN_BROWSER_PILOT_COMPLETE";
            }
          }
        }
      }
    }
  } catch (error) {
    errorCode = error?.code ?? error?.message ?? "UNKNOWN_ERROR";
    outcome = errorOutcome(error);
  } finally {
    if (renderer) {
      try {
        transportSummary = await renderer.close();
      } catch (error) {
        errorCode = error?.code ?? "MODERN_BROWSER_CLEANUP_FAILED";
        outcome = "PHASE6C_MYFANS_SECURITY_FAILED";
        transportSummary = renderer.summary();
      }
    }
  }
  const artifacts = await persistArtifacts({
    outputDir,
    environment,
    outcome,
    errorCode,
    discoveryCandidates,
    creators,
    posts,
    rankingObservation,
    transportSummary,
    postDetailVerified,
    cloudTiming,
  });
  const validation = await validateCloudArtifactDirectory(outputDir);
  return {
    outcome,
    error_code: errorCode,
    browser_navigation: artifacts.requestSummary.browser_navigation,
    creator_structures: rankingObservation.creator_structure_count,
    creator_candidates: creators.length,
    safe_creators: artifacts.safeCreators.length,
    post_candidates: posts.length,
    safe_posts: artifacts.safePosts.length,
    post_detail_verified: postDetailVerified,
    artifact_validation: validation,
  };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv[0] !== "--output-dir" || !argv[1]) throw new Error("Usage: myfans-cloud-public-pilot.mjs --output-dir <runner-temp-path>");
  const result = await runCloudPilot({ outputDir: path.resolve(argv[1]) });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main().catch((error) => {
    console.error(error?.code ?? error?.message ?? "CLOUD_PILOT_FAILED");
    process.exitCode = 1;
  });
}
