#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import {
  MYFANS_CLASSIFICATIONS,
  MYFANS_ORIGIN,
  assertNoRawHtmlPersisted,
  createPublicHtmlFetcher,
  dedupeFrozenRecords,
  detectPublicPageAccess,
  discoverPublicLinks,
  metadataHash,
  parseCreatorPage,
  parsePostPage,
  planStagingChanges,
  readFrozenJsonlGzip,
  summarizeStagingPlan,
  writeFrozenJsonlGzip,
  writeJson,
} from "./lib/myfans-public-metadata.mjs";

const DATA_SOURCE_CONTRACT = Object.freeze({
  name: "MyFans Public Metadata",
  source_type: "other",
  priority: 100,
  terms_note: "Public metadata only; paid, limited, protected media, and authenticated content are excluded.",
  is_active: false,
});
const WRITE_CONFIRMATION = "PHASE6C_PRIVATE_STAGING";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`UNKNOWN_ARGUMENT:${key}`);
    const name = key.slice(2);
    if (["help"].includes(name)) args[name] = true;
    else {
      const value = argv[index + 1];
      if (value == null || value.startsWith("--")) throw new Error(`MISSING_ARGUMENT_VALUE:${name}`);
      args[name] = value;
      index += 1;
    }
  }
  return args;
}

function numberArg(value, fallback, { min, max, name }) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`INVALID_${name.toUpperCase()}`);
  return parsed;
}

function classificationCounts(records) {
  const values = Object.values(MYFANS_CLASSIFICATIONS);
  return Object.fromEntries(values.map((value) => [value, records.filter((record) => record.classification === value).length]));
}

function roundRobin(groups, limit) {
  const queues = groups.map((group) => [...group]);
  const result = [];
  const seen = new Set();
  while (result.length < limit && queues.some((queue) => queue.length)) {
    for (const queue of queues) {
      const value = queue.shift();
      if (value && !seen.has(value)) {
        result.push(value);
        seen.add(value);
        if (result.length >= limit) break;
      }
    }
  }
  return result;
}

function frozenManifest(records) {
  const membership = records.map((record) => `${record.entity_type}:${record.external_id ?? "missing"}`).sort();
  const hashes = records.map((record) => ({
    entity_type: record.entity_type,
    external_id: record.external_id,
    metadata_hash: record.metadata_hash,
    source_page_hash: record.source_page_hash,
    classification: record.classification,
  })).sort((a, b) => `${a.entity_type}:${a.external_id}`.localeCompare(`${b.entity_type}:${b.external_id}`));
  return {
    record_count: records.length,
    membership_sha256: metadataHash(membership),
    manifest_sha256: metadataHash(hashes),
  };
}

function exactLinkCandidates(records) {
  const results = [];
  for (const record of records) {
    if (record.classification !== MYFANS_CLASSIFICATIONS.SAFE) continue;
    const text = JSON.stringify(record.raw_public_metadata);
    const codes = [...new Set(text.match(/\b(?:[A-Z0-9]+[_-])?[A-Z]{2,10}[-_]?\d{3,8}\b/g) ?? [])];
    const urls = [...new Set(text.match(/https:\/\/(?:www[.])?dmm[.]co[.]jp\/[^"]+/g) ?? [])];
    if (codes.length || urls.length) results.push({ entity_type: record.entity_type, external_id: record.external_id, fanza_product_codes: codes, official_fanza_urls: urls, apply: false });
  }
  return results;
}

async function persistProbeArtifacts({ outputDir, creators, posts, requestSummary, listing, postDetailVerified }) {
  const records = dedupeFrozenRecords([...creators, ...posts]);
  assertNoRawHtmlPersisted(records);
  const safeCreators = records.filter((record) => record.entity_type === "creator" && record.classification === MYFANS_CLASSIFICATIONS.SAFE);
  const safePosts = records.filter((record) => record.entity_type === "post" && record.classification === MYFANS_CLASSIFICATIONS.SAFE);
  const exactLinks = exactLinkCandidates(records);
  const manifest = frozenManifest(records);
  const classification = {
    generated_at: new Date().toISOString(),
    creator: classificationCounts(records.filter((record) => record.entity_type === "creator")),
    post: classificationCounts(records.filter((record) => record.entity_type === "post")),
    exact_link_candidates: exactLinks.length,
    auto_links_created: 0,
  };
  const frozenSummary = {
    generated_at: new Date().toISOString(),
    parser_version: records[0]?.parser_version ?? "phase6c-v1",
    ...manifest,
    creators: creators.length,
    posts: posts.length,
    safe_creators: safeCreators.length,
    safe_posts: safePosts.length,
    raw_html_stored: 0,
    image_bodies_stored: 0,
    video_bodies_stored: 0,
    apply: false,
    post_detail_verified: postDetailVerified,
  };
  const summary = {
    ...requestSummary,
    listing_url: listing.url,
    listing_status: listing.status,
    listing_access: listing.access,
    creator_gets: requestSummary.requests.filter((entry) => entry.label?.startsWith("creator:")).length,
    post_gets: requestSummary.requests.filter((entry) => entry.label?.startsWith("post:")).length,
    listing_gets: requestSummary.requests.filter((entry) => entry.label === "listing").length,
    robots_terms_gets: 0,
  };
  await Promise.all([
    writeJson(path.join(outputDir, "creator-candidates.json"), { generated_at: frozenSummary.generated_at, apply: false, records: creators }),
    writeJson(path.join(outputDir, "post-candidates.json"), { generated_at: frozenSummary.generated_at, apply: false, records: posts }),
    writeJson(path.join(outputDir, "safe-creators.json"), { generated_at: frozenSummary.generated_at, apply: false, records: safeCreators }),
    writeJson(path.join(outputDir, "safe-posts.json"), { generated_at: frozenSummary.generated_at, apply: false, records: safePosts }),
    writeJson(path.join(outputDir, "frozen-summary.json"), frozenSummary),
    writeJson(path.join(outputDir, "classification-summary.json"), classification),
    writeJson(path.join(outputDir, "request-summary.json"), summary),
    writeJson(path.join(outputDir, "exact-link-candidates.json"), { generated_at: frozenSummary.generated_at, apply: false, records: exactLinks }),
    writeFrozenJsonlGzip(path.join(outputDir, "myfans-public-pilot.jsonl.gz"), records),
  ]);
  return { records, safeCreators, safePosts, exactLinks, frozenSummary, classification, requestSummary: summary };
}

async function runProbe(args) {
  const outputDir = path.resolve(args["output-dir"] ?? "/Users/saitoutomoya/Documents/Codex/okazudb-state/myfans-research/phase6c-pilot");
  const listingUrl = args["listing-url"] ?? MYFANS_ORIGIN;
  const maxCreators = numberArg(args["max-creators"], 5, { min: 1, max: 5, name: "max_creators" });
  const maxPosts = numberArg(args["max-posts"], 30, { min: 1, max: 30, name: "max_posts" });
  const fetcher = createPublicHtmlFetcher({ maxRequests: 40, maxRetries: 1 });
  const creators = [];
  const posts = [];

  const listingResponse = await fetcher.fetchHtml(listingUrl, { label: "listing" });
  const listingAccess = detectPublicPageAccess(listingResponse);
  const listing = { url: listingResponse.url, status: listingResponse.status, access: listingAccess };
  let postDetailVerified = false;

  if (listingAccess.classification === MYFANS_CLASSIFICATIONS.SAFE) {
    const listingLinks = discoverPublicLinks(listingResponse.html, listingResponse.url);
    const creatorUrls = listingLinks.creator_urls.slice(0, maxCreators);
    const postUrlGroups = [];
    for (const [index, creatorUrl] of creatorUrls.entries()) {
      const response = await fetcher.fetchHtml(creatorUrl, { label: `creator:${index + 1}` });
      const record = parseCreatorPage({ html: response.html, sourceUrl: creatorUrl, fetchedAt: response.fetched_at, status: response.status, location: response.location });
      creators.push(record);
      postUrlGroups.push(response.status === 200 ? discoverPublicLinks(response.html, response.url).post_urls : []);
    }
    if (listingLinks.post_urls.length) postUrlGroups.push(listingLinks.post_urls);
    const postUrls = roundRobin(postUrlGroups, maxPosts);
    const knownCreators = creators.filter((record) => record.classification === MYFANS_CLASSIFICATIONS.SAFE).map((record) => record.external_id);
    if (postUrls.length && knownCreators.length) {
      const gateResponse = await fetcher.fetchHtml(postUrls[0], { label: "post:gate" });
      const gateRecord = parsePostPage({ html: gateResponse.html, sourceUrl: postUrls[0], knownCreatorExternalIds: knownCreators, fetchedAt: gateResponse.fetched_at, status: gateResponse.status, location: gateResponse.location });
      posts.push(gateRecord);
      postDetailVerified = gateRecord.classification === MYFANS_CLASSIFICATIONS.SAFE;
      if (postDetailVerified) {
        for (const [index, postUrl] of postUrls.slice(1).entries()) {
          const response = await fetcher.fetchHtml(postUrl, { label: `post:${index + 2}` });
          posts.push(parsePostPage({ html: response.html, sourceUrl: postUrl, knownCreatorExternalIds: knownCreators, fetchedAt: response.fetched_at, status: response.status, location: response.location }));
        }
      }
    }
  }

  const artifacts = await persistProbeArtifacts({ outputDir, creators, posts, requestSummary: fetcher.summary(), listing, postDetailVerified });
  const result = {
    output_dir: outputDir,
    listing_access: listingAccess.classification,
    creator_candidates: creators.length,
    post_candidates: posts.length,
    safe_creators: artifacts.safeCreators.length,
    safe_posts: artifacts.safePosts.length,
    post_detail_verified: postDetailVerified,
    request_summary: artifacts.requestSummary,
    manifest: artifacts.frozenSummary,
  };
  console.log(JSON.stringify(result, null, 2));
  if (listingAccess.classification !== MYFANS_CLASSIFICATIONS.SAFE) process.exitCode = 3;
  else if (!postDetailVerified) process.exitCode = 4;
  return result;
}

async function loadSafeRecords(outputDir) {
  const frozen = await readFrozenJsonlGzip(path.join(outputDir, "myfans-public-pilot.jsonl.gz"));
  assertNoRawHtmlPersisted(frozen);
  return {
    creators: frozen.filter((record) => record.entity_type === "creator" && record.classification === MYFANS_CLASSIFICATIONS.SAFE),
    posts: frozen.filter((record) => record.entity_type === "post" && record.classification === MYFANS_CLASSIFICATIONS.SAFE),
  };
}

function sourceContractState(source) {
  if (!source) return { state: "NEW", reason: "TARGET_SOURCE_ABSENT" };
  const exact = source.name === DATA_SOURCE_CONTRACT.name
    && source.source_type === DATA_SOURCE_CONTRACT.source_type
    && source.priority === DATA_SOURCE_CONTRACT.priority
    && source.terms_note === DATA_SOURCE_CONTRACT.terms_note
    && source.is_active === false;
  return exact ? { state: "UNCHANGED", reason: "EXACT_SOURCE_CONTRACT" } : { state: "CONFLICT", reason: "DATA_SOURCE_CONTRACT_MISMATCH" };
}

async function queryTargetState(sql, records) {
  const creatorIds = records.creators.map((record) => record.external_id);
  const creatorUrls = records.creators.map((record) => record.official_url);
  const postIds = records.posts.map((record) => record.external_id);
  const postUrls = records.posts.map((record) => record.official_url);
  const sources = await sql`
    select id, name, source_type, priority, terms_note, is_active
    from public.data_sources where name = ${DATA_SOURCE_CONTRACT.name}
  `;
  const source = sources[0] ?? null;
  const creators = creatorIds.length ? await sql`
    select data_source_id, external_creator_id as external_id, official_url, metadata_hash, visibility, review_status
    from public.myfans_creators
    where external_creator_id in ${sql(creatorIds)} or official_url in ${sql(creatorUrls)}
  ` : [];
  const posts = postIds.length ? await sql`
    select p.data_source_id, p.external_post_id as external_id, p.official_url, p.metadata_hash,
      p.visibility, p.review_status, c.external_creator_id as creator_external_id
    from public.myfans_posts p join public.myfans_creators c on c.id = p.creator_id
    where p.external_post_id in ${sql(postIds)} or p.official_url in ${sql(postUrls)}
  ` : [];
  return { source, creators, posts };
}

function buildPlan(records, state) {
  const source = sourceContractState(state.source);
  const options = { targetDataSourceId: state.source?.id ?? null, targetSourceAbsent: !state.source };
  const creators = planStagingChanges(records.creators, state.creators, options);
  const acceptableCreators = new Set(creators.filter((entry) => entry.state === "NEW" || entry.state === "UNCHANGED").map((entry) => entry.external_id));
  const posts = planStagingChanges(records.posts, state.posts, options).map((entry) => acceptableCreators.has(entry.record.creator_external_id)
    ? entry
    : { ...entry, state: "CONFLICT", reason: "CREATOR_NOT_STAGED" });
  return {
    source,
    creator: summarizeStagingPlan(creators),
    post: summarizeStagingPlan(posts),
    creator_entries: creators,
    post_entries: posts,
    business_mutation: 0,
  };
}

function publicPlan(plan) {
  return {
    source: plan.source,
    creator: plan.creator,
    post: plan.post,
    business_mutation: plan.business_mutation,
    creator_states: plan.creator_entries.map(({ external_id, state, reason }) => ({ external_id, state, reason })),
    post_states: plan.post_entries.map(({ external_id, state, reason }) => ({ external_id, state, reason })),
  };
}

function assertWritablePlan(plan) {
  if (plan.source.state === "CONFLICT") throw new Error("DATA_SOURCE_CONFLICT");
  if (plan.creator.EXISTING_CHANGED || plan.creator.CONFLICT || plan.post.EXISTING_CHANGED || plan.post.CONFLICT) throw new Error("STAGING_PLAN_CONFLICT");
}

async function insertNewRecords(tx, records, plan) {
  let source = (await tx`
    select id, name, source_type, priority, terms_note, is_active
    from public.data_sources where name = ${DATA_SOURCE_CONTRACT.name} for update
  `)[0] ?? null;
  let sourceCreated = false;
  if (source && sourceContractState(source).state !== "UNCHANGED") throw new Error("DATA_SOURCE_CONTRACT_CHANGED_AFTER_PREFLIGHT");
  if (!source) {
    [source] = await tx`
      insert into public.data_sources(name, source_type, priority, terms_note, is_active)
      values(${DATA_SOURCE_CONTRACT.name}, ${DATA_SOURCE_CONTRACT.source_type}, ${DATA_SOURCE_CONTRACT.priority}, ${DATA_SOURCE_CONTRACT.terms_note}, false)
      returning id
    `;
    sourceCreated = true;
  }
  let creatorsInserted = 0;
  for (const entry of plan.creator_entries.filter((item) => item.state === "NEW")) {
    const record = entry.record;
    await tx`
      insert into public.myfans_creators(
        data_source_id, external_creator_id, profile_slug, display_name, official_url,
        profile_image_url, bio, visibility, review_status, raw_public_metadata, metadata_hash, fetched_at
      ) values(
        ${source.id}, ${record.external_id}, ${record.normalized.profile_slug}, ${record.normalized.display_name},
        ${record.official_url}, ${record.normalized.profile_image_url}, ${record.normalized.bio}, 'public',
        'public_metadata_staged', ${tx.json(record.raw_public_metadata)}, ${record.metadata_hash}, ${record.fetched_at}
      )
    `;
    creatorsInserted += 1;
  }
  const creatorIds = [...new Set(records.posts.map((record) => record.creator_external_id).filter(Boolean))];
  const creatorRows = creatorIds.length ? await tx`
    select id, external_creator_id from public.myfans_creators
    where data_source_id = ${source.id} and external_creator_id in ${tx(creatorIds)}
  ` : [];
  const creatorMap = new Map(creatorRows.map((row) => [row.external_creator_id, row.id]));
  let postsInserted = 0;
  for (const entry of plan.post_entries.filter((item) => item.state === "NEW")) {
    const record = entry.record;
    const creatorId = creatorMap.get(record.creator_external_id);
    if (!creatorId) throw new Error(`CREATOR_FK_NOT_FOUND:${record.external_id}`);
    await tx`
      insert into public.myfans_posts(
        data_source_id, creator_id, external_post_id, source_product_id, title, teaser, official_url,
        thumbnail_url, published_at, content_type, media_indicator, sample_available, visibility,
        price, currency, review_status, raw_public_metadata, metadata_hash, fetched_at
      ) values(
        ${source.id}, ${creatorId}, ${record.external_id}, null, ${record.normalized.title}, ${record.normalized.teaser},
        ${record.official_url}, ${record.normalized.thumbnail_url}, ${record.normalized.published_at},
        ${record.normalized.content_type}, ${record.normalized.media_indicator}, ${record.normalized.sample_available},
        'public', null, 'JPY', 'public_metadata_staged', ${tx.json(record.raw_public_metadata)},
        ${record.metadata_hash}, ${record.fetched_at}
      )
    `;
    postsInserted += 1;
  }
  return { source_id: source.id, source_created: sourceCreated, creators_inserted: creatorsInserted, posts_inserted: postsInserted };
}

async function connectDatabase() {
  if (!process.env.SUPABASE_DB_URL) throw new Error("SUPABASE_DB_URL_REQUIRED");
  const { default: postgres } = await import("postgres");
  return postgres(process.env.SUPABASE_DB_URL, { ssl: "require", max: 1, prepare: false, idle_timeout: 20, connect_timeout: 20 });
}

async function runDbMode(args, mode) {
  const outputDir = path.resolve(args["output-dir"] ?? "/Users/saitoutomoya/Documents/Codex/okazudb-state/myfans-research/phase6c-pilot");
  const records = await loadSafeRecords(outputDir);
  if (records.creators.length > 5 || records.posts.length > 30) throw new Error("PILOT_SCOPE_EXCEEDED");
  const sql = await connectDatabase();
  try {
    if (mode === "dry-run") {
      const result = await sql.begin(async (tx) => {
        await tx`set transaction read only`;
        return buildPlan(records, await queryTargetState(tx, records));
      });
      const output = { generated_at: new Date().toISOString(), mode, ...publicPlan(result) };
      await writeJson(path.join(outputDir, "db-dry-run.json"), output);
      console.log(JSON.stringify(output, null, 2));
      return output;
    }
    if (mode === "write") {
      if (args.confirm !== WRITE_CONFIRMATION) throw new Error("WRITE_CONFIRMATION_REQUIRED");
      const preflight = await sql.begin(async (tx) => {
        await tx`set transaction read only`;
        return buildPlan(records, await queryTargetState(tx, records));
      });
      assertWritablePlan(preflight);
      const applied = await sql.begin(async (tx) => insertNewRecords(tx, records, preflight));
      const output = { generated_at: new Date().toISOString(), mode, preflight: publicPlan(preflight), applied };
      await writeJson(path.join(outputDir, "db-write.json"), output);
      console.log(JSON.stringify(output, null, 2));
      return output;
    }
    if (mode === "verify") {
      const result = await sql.begin(async (tx) => {
        await tx`set transaction read only`;
        const plan = buildPlan(records, await queryTargetState(tx, records));
        const source = await tx`select id, is_active from public.data_sources where name = ${DATA_SOURCE_CONTRACT.name}`;
        const security = await tx`
          select
            has_table_privilege('anon', 'public.myfans_creators', 'SELECT') as creators_anon_select,
            has_table_privilege('anon', 'public.myfans_posts', 'SELECT') as posts_anon_select,
            (select count(*)::int from pg_policies where schemaname = 'public' and tablename in ('myfans_creators','myfans_posts') and 'anon' = any(roles)) as anon_policies,
            (select count(*)::int from public.myfans_plans) as plans,
            (select count(*)::int from public.myfans_post_plans) as post_plans,
            (select count(*)::int from public.video_source_link_evidence) as link_evidence,
            (select count(*)::int from public.source_products where data_source_id = source.id) as source_products
          from (select id from public.data_sources where name = ${DATA_SOURCE_CONTRACT.name}) source
        `;
        return { plan, source: source[0] ?? null, security: security[0] ?? null };
      });
      const pass = result.plan.creator.NEW === 0 && result.plan.post.NEW === 0
        && result.plan.creator.EXISTING_CHANGED === 0 && result.plan.creator.CONFLICT === 0
        && result.plan.post.EXISTING_CHANGED === 0 && result.plan.post.CONFLICT === 0
        && result.source?.is_active === false
        && result.security?.creators_anon_select === false && result.security?.posts_anon_select === false
        && result.security?.anon_policies === 0
        && result.security?.plans === 0 && result.security?.post_plans === 0
        && result.security?.link_evidence === 0 && result.security?.source_products === 0;
      if (!pass) throw new Error("TARGETED_VERIFY_FAILED");
      const output = { generated_at: new Date().toISOString(), mode, pass, plan: publicPlan(result.plan), source: result.source, security: result.security };
      await writeJson(path.join(outputDir, "db-verify.json"), output);
      console.log(JSON.stringify(output, null, 2));
      return output;
    }
    throw new Error(`UNKNOWN_MODE:${mode}`);
  } finally {
    await sql.end();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log("Usage: myfans-public-pilot.mjs --mode probe|dry-run|write|verify --output-dir <path>");
    return;
  }
  const mode = args.mode ?? "probe";
  if (mode === "probe") return runProbe(args);
  return runDbMode(args, mode);
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: error?.message ?? "UNKNOWN_ERROR" }));
    process.exitCode = 1;
  });
}

export { DATA_SOURCE_CONTRACT, WRITE_CONFIRMATION, buildPlan, sourceContractState };
