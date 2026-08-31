import { createHash } from "node:crypto";
import { createGzip, gunzipSync } from "node:zlib";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

export const MYFANS_PARSER_VERSION = "phase6c-v1";
export const MYFANS_ORIGIN = "https://myfans.jp";
export const MYFANS_CLASSIFICATIONS = Object.freeze({
  SAFE: "PUBLIC_SAFE_METADATA",
  REVIEW: "PUBLIC_NEEDS_REVIEW",
  AUTH: "AUTH_REQUIRED",
  PAID: "PAID_PROTECTED",
  UNSUPPORTED: "UNSUPPORTED",
  DUPLICATE: "DUPLICATE",
  INVALID: "INVALID",
  BLOCKED: "SOURCE_ACCESS_BLOCKED",
});

const RESERVED_CREATOR_SLUGS = new Set([
  "about", "account", "admin", "api", "auth", "categories", "category", "contact",
  "creators", "discover", "faq", "help", "home", "login", "logout", "media", "plans",
  "posts", "privacy", "ranking", "rankings", "register", "search", "settings", "signin",
  "signup", "support", "terms", "users",
]);
const LOGIN_MARKERS = [
  /<form[^>]+(?:login|sign[-_ ]?in)/i,
  /(?:ログイン|サインイン).{0,80}(?:必要|してください)/i,
  /(?:login|sign in).{0,80}(?:required|continue)/i,
];
const AGE_GATE_MARKERS = [
  /18歳未満.{0,80}(?:閲覧|利用|禁止|戻)/i,
  /(?:18歳以上|成人).{0,80}(?:確認|同意|入場)/i,
  /age.{0,30}(?:verification|confirmation|gate)/i,
];
const PAID_MARKERS = [
  /(?:有料|購入|課金|プラン加入|会員限定|購読者限定|支援者限定)/i,
  /(?:subscribe|subscription|subscribers? only|members? only|paid content|purchase required)/i,
];
const LIMITED_MARKERS = [
  /(?:限定公開|フォロワー限定|閲覧期限|公開終了)/i,
  /(?:limited access|followers? only|restricted content)/i,
];

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function metadataHash(value) {
  return sha256(stableStringify(value));
}

function decodeHtmlEntities(value) {
  return String(value ?? "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function cleanText(value, maxLength = 500) {
  if (value == null) return null;
  const cleaned = decodeHtmlEntities(String(value)).replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLength);
}

function parseTagAttributes(tag) {
  const attributes = {};
  const pattern = /([:@a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const match of tag.matchAll(pattern)) {
    attributes[match[1].toLowerCase()] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function flattenJsonLd(value) {
  if (Array.isArray(value)) return value.flatMap(flattenJsonLd);
  if (!value || typeof value !== "object") return [];
  const graph = Array.isArray(value["@graph"]) ? value["@graph"].flatMap(flattenJsonLd) : [];
  return [value, ...graph];
}

export function extractPublicMetadata(html, baseUrl = MYFANS_ORIGIN) {
  const jsonLd = [];
  const scriptPattern = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;
  for (const match of String(html).matchAll(scriptPattern)) {
    try {
      jsonLd.push(...flattenJsonLd(JSON.parse(match[1].trim())));
    } catch {
      // Malformed JSON-LD is ignored; fail-closed classification handles missing fields.
    }
  }

  const meta = {};
  for (const match of String(html).matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = parseTagAttributes(match[0]);
    const key = (attributes.property ?? attributes.name ?? "").toLowerCase();
    if (key && attributes.content != null && meta[key] == null) meta[key] = cleanText(attributes.content, 2000);
  }
  for (const match of String(html).matchAll(/<link\b[^>]*>/gi)) {
    const attributes = parseTagAttributes(match[0]);
    if (String(attributes.rel ?? "").toLowerCase() === "canonical" && attributes.href && !meta.canonical) {
      meta.canonical = canonicalizeMyFansUrl(attributes.href, baseUrl, { allowRoot: true });
    }
  }
  const titleMatch = String(html).match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  if (titleMatch) meta.title = cleanText(titleMatch[1], 300);

  const links = [];
  for (const match of String(html).matchAll(/<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const value = match[1] ?? match[2] ?? match[3];
    const url = canonicalizeMyFansUrl(decodeHtmlEntities(value), baseUrl, { allowRoot: true });
    if (url) links.push(url);
  }
  return { jsonLd, meta, links: [...new Set(links)] };
}

export function canonicalizeMyFansUrl(value, baseUrl = MYFANS_ORIGIN, { allowRoot = false } = {}) {
  try {
    const url = new URL(String(value), baseUrl);
    if (url.protocol !== "https:" || url.hostname !== "myfans.jp" || url.port || url.username || url.password) return null;
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
    if (!allowRoot && url.pathname === "/") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function validateMetadataUrl(value, baseUrl = MYFANS_ORIGIN) {
  if (value == null) return null;
  try {
    const url = new URL(String(value), baseUrl);
    if (url.protocol !== "https:" || url.port || url.username || url.password) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function creatorSlugFromUrl(value) {
  const canonical = canonicalizeMyFansUrl(value);
  if (!canonical) return null;
  const parts = new URL(canonical).pathname.split("/").filter(Boolean);
  if (parts.length !== 1) return null;
  const slug = parts[0];
  if (!/^[a-zA-Z0-9_-]{2,100}$/.test(slug) || RESERVED_CREATOR_SLUGS.has(slug.toLowerCase())) return null;
  return slug;
}

export function postIdFromUrl(value) {
  const canonical = canonicalizeMyFansUrl(value);
  if (!canonical) return null;
  const match = new URL(canonical).pathname.match(/^\/posts\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function firstJsonLd(jsonLd, types) {
  const expected = new Set(types.map((value) => value.toLowerCase()));
  return jsonLd.find((entry) => {
    const raw = Array.isArray(entry["@type"]) ? entry["@type"] : [entry["@type"]];
    return raw.some((value) => expected.has(String(value ?? "").toLowerCase()));
  }) ?? jsonLd.find((entry) => entry.name || entry.headline || entry.description) ?? null;
}

function valueFromImage(image) {
  if (typeof image === "string") return image;
  if (Array.isArray(image)) return valueFromImage(image[0]);
  if (image && typeof image === "object") return image.url ?? image.contentUrl ?? null;
  return null;
}

function accessFailure({ status = 200, location = null, html = "" } = {}) {
  if (status === 401) return { classification: MYFANS_CLASSIFICATIONS.AUTH, reason_codes: ["HTTP_401_AUTH_REQUIRED"] };
  if (status === 403) return { classification: MYFANS_CLASSIFICATIONS.BLOCKED, reason_codes: ["HTTP_403_SOURCE_BLOCKED"] };
  if (status === 429) return { classification: MYFANS_CLASSIFICATIONS.BLOCKED, reason_codes: ["HTTP_429_NO_RETRY"] };
  if (status >= 500) return { classification: MYFANS_CLASSIFICATIONS.BLOCKED, reason_codes: [`HTTP_${status}_SOURCE_ERROR`] };
  if (status >= 300 && status < 400) {
    if (/\b(?:login|signin|auth)\b/i.test(String(location))) return { classification: MYFANS_CLASSIFICATIONS.AUTH, reason_codes: ["AUTH_REDIRECT_REJECTED"] };
    return { classification: MYFANS_CLASSIFICATIONS.BLOCKED, reason_codes: ["REDIRECT_NOT_FOLLOWED"] };
  }
  if (status !== 200) return { classification: MYFANS_CLASSIFICATIONS.BLOCKED, reason_codes: [`HTTP_${status}_UNSUPPORTED`] };
  if (LOGIN_MARKERS.some((pattern) => pattern.test(html))) return { classification: MYFANS_CLASSIFICATIONS.AUTH, reason_codes: ["LOGIN_WALL_REJECTED"] };
  if (AGE_GATE_MARKERS.some((pattern) => pattern.test(html))) return { classification: MYFANS_CLASSIFICATIONS.BLOCKED, reason_codes: ["AGE_INTERSTITIAL_NOT_BYPASSED"] };
  return null;
}

export function detectPublicPageAccess(input) {
  return accessFailure(input) ?? { classification: MYFANS_CLASSIFICATIONS.SAFE, reason_codes: ["ANONYMOUS_HTTP_200"] };
}

function restrictedVisibility(html, jsonLd) {
  const accessible = jsonLd.find((entry) => entry.isAccessibleForFree != null)?.isAccessibleForFree;
  const offerPrice = jsonLd.flatMap((entry) => Array.isArray(entry.offers) ? entry.offers : [entry.offers]).find(Boolean)?.price;
  if (accessible === false || (offerPrice != null && Number(offerPrice) > 0) || PAID_MARKERS.some((pattern) => pattern.test(html))) return "paid";
  if (LIMITED_MARKERS.some((pattern) => pattern.test(html))) return "limited";
  return "public";
}

function absoluteTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function recordEnvelope({ entityType, externalId, creatorExternalId = null, sourceUrl, officialUrl, fetchedAt, visibility, normalized, rawPublicMetadata, sourcePageHash, classification, reasonCodes }) {
  return {
    entity_type: entityType,
    external_id: externalId,
    creator_external_id: creatorExternalId,
    source_url: sourceUrl,
    official_url: officialUrl,
    fetched_at: fetchedAt,
    visibility,
    normalized,
    raw_public_metadata: rawPublicMetadata,
    metadata_hash: metadataHash(rawPublicMetadata),
    parser_version: MYFANS_PARSER_VERSION,
    classification,
    reason_codes: [...new Set(reasonCodes)].sort(),
    source_page_hash: sourcePageHash,
  };
}

export function parseCreatorPage({ html, sourceUrl, fetchedAt = new Date().toISOString(), status = 200, location = null }) {
  const canonicalSource = canonicalizeMyFansUrl(sourceUrl);
  const slug = creatorSlugFromUrl(canonicalSource);
  const pageHash = sha256(String(html));
  const failure = accessFailure({ status, location, html });
  if (failure || !slug) {
    return recordEnvelope({
      entityType: "creator", externalId: slug, sourceUrl: canonicalSource ?? sourceUrl,
      officialUrl: canonicalSource, fetchedAt, visibility: "unknown", normalized: null,
      rawPublicMetadata: {}, sourcePageHash: pageHash,
      classification: failure?.classification ?? MYFANS_CLASSIFICATIONS.UNSUPPORTED,
      reasonCodes: failure?.reason_codes ?? ["STABLE_CREATOR_ID_MISSING"],
    });
  }

  const extracted = extractPublicMetadata(html, canonicalSource);
  const structured = firstJsonLd(extracted.jsonLd, ["Person", "ProfilePage"]);
  const displayName = cleanText(structured?.name ?? extracted.meta["og:title"] ?? extracted.meta.title, 200);
  const description = cleanText(structured?.description ?? extracted.meta["og:description"], 500);
  const profileImageUrl = validateMetadataUrl(valueFromImage(structured?.image) ?? extracted.meta["og:image"], canonicalSource);
  const claimedCanonical = canonicalizeMyFansUrl(structured?.url ?? extracted.meta["og:url"] ?? extracted.meta.canonical ?? canonicalSource);
  const officialUrl = creatorSlugFromUrl(claimedCanonical) === slug ? claimedCanonical : canonicalSource;
  const sourceKind = structured ? "json_ld" : "open_graph";
  const rawPublicMetadata = {
    source_kind: sourceKind,
    profile_slug: slug,
    display_name: displayName,
    official_url: officialUrl,
    profile_image_url: profileImageUrl,
    bio_excerpt: description,
  };
  const safe = Boolean(displayName && officialUrl);
  const normalized = safe ? {
    external_creator_id: slug,
    profile_slug: slug,
    display_name: displayName,
    official_url: officialUrl,
    profile_image_url: profileImageUrl,
    bio: description,
    visibility: "public",
    review_status: "public_metadata_staged",
  } : null;
  return recordEnvelope({
    entityType: "creator", externalId: slug, sourceUrl: canonicalSource, officialUrl,
    fetchedAt, visibility: safe ? "public" : "unknown", normalized,
    rawPublicMetadata, sourcePageHash: pageHash,
    classification: safe ? MYFANS_CLASSIFICATIONS.SAFE : MYFANS_CLASSIFICATIONS.REVIEW,
    reasonCodes: safe ? ["ANONYMOUS_HTTP_200", "STABLE_CREATOR_ID", sourceKind.toUpperCase()] : ["PUBLIC_CREATOR_METADATA_INCOMPLETE"],
  });
}

function creatorSlugFromAuthor(author, baseUrl) {
  if (Array.isArray(author)) return author.map((entry) => creatorSlugFromAuthor(entry, baseUrl)).find(Boolean) ?? null;
  if (typeof author === "string") {
    if (!/^https:\/\/myfans[.]jp\/|^\//i.test(author)) return null;
    return creatorSlugFromUrl(new URL(author, baseUrl).toString()) ?? null;
  }
  if (!author || typeof author !== "object") return null;
  return creatorSlugFromUrl(author.url ?? author["@id"] ?? "") ?? null;
}

export function parsePostPage({ html, sourceUrl, knownCreatorExternalIds = [], fetchedAt = new Date().toISOString(), status = 200, location = null }) {
  const canonicalSource = canonicalizeMyFansUrl(sourceUrl);
  const postId = postIdFromUrl(canonicalSource);
  const pageHash = sha256(String(html));
  const failure = accessFailure({ status, location, html });
  if (failure || !postId) {
    return recordEnvelope({
      entityType: "post", externalId: postId, sourceUrl: canonicalSource ?? sourceUrl,
      officialUrl: canonicalSource, fetchedAt, visibility: "unknown", normalized: null,
      rawPublicMetadata: {}, sourcePageHash: pageHash,
      classification: failure?.classification ?? MYFANS_CLASSIFICATIONS.UNSUPPORTED,
      reasonCodes: failure?.reason_codes ?? ["STABLE_POST_ID_MISSING"],
    });
  }

  const extracted = extractPublicMetadata(html, canonicalSource);
  const structured = firstJsonLd(extracted.jsonLd, ["Article", "SocialMediaPosting", "BlogPosting", "VideoObject", "ImageObject"]);
  const title = cleanText(structured?.headline ?? structured?.name ?? extracted.meta["og:title"] ?? extracted.meta.title, 300);
  const teaser = cleanText(structured?.description ?? extracted.meta["og:description"], 500);
  const claimedCanonical = canonicalizeMyFansUrl(structured?.url ?? extracted.meta["og:url"] ?? extracted.meta.canonical ?? canonicalSource);
  const officialUrl = postIdFromUrl(claimedCanonical) === postId ? claimedCanonical : canonicalSource;
  const authorFromStructured = creatorSlugFromAuthor(structured?.author, canonicalSource);
  const authorFromLinks = extracted.links.map(creatorSlugFromUrl).find((slug) => slug && knownCreatorExternalIds.includes(slug));
  const creatorExternalId = authorFromStructured ?? authorFromLinks ?? null;
  const publishedAt = absoluteTimestamp(structured?.datePublished ?? extracted.meta["article:published_time"]);
  const thumbnailUrl = validateMetadataUrl(valueFromImage(structured?.image) ?? structured?.thumbnailUrl ?? extracted.meta["og:image"], canonicalSource);
  const visibility = restrictedVisibility(html, extracted.jsonLd);
  const sourceKind = structured ? "json_ld" : "open_graph";
  const typeValue = String(structured?.["@type"] ?? "").toLowerCase();
  const mediaIndicator = /video/.test(typeValue) || structured?.video ? "video" : (/image/.test(typeValue) || structured?.image ? "image" : "unknown");
  const rawPublicMetadata = {
    source_kind: sourceKind,
    external_post_id: postId,
    creator_external_id: creatorExternalId,
    official_url: officialUrl,
    title,
    teaser,
    thumbnail_url: thumbnailUrl,
    published_at: publishedAt,
    relative_time: publishedAt ? null : cleanText(extracted.meta["article:modified_time"] ?? null, 100),
    media_indicator: mediaIndicator,
  };

  if (visibility !== "public") {
    return recordEnvelope({
      entityType: "post", externalId: postId, creatorExternalId, sourceUrl: canonicalSource,
      officialUrl, fetchedAt, visibility, normalized: null, rawPublicMetadata,
      sourcePageHash: pageHash, classification: MYFANS_CLASSIFICATIONS.PAID,
      reasonCodes: [visibility === "paid" ? "PAID_METADATA_EXCLUDED" : "LIMITED_METADATA_EXCLUDED"],
    });
  }
  const creatorKnown = Boolean(creatorExternalId && knownCreatorExternalIds.includes(creatorExternalId));
  const safe = Boolean(title && officialUrl && creatorKnown);
  const normalized = safe ? {
    external_post_id: postId,
    creator_external_id: creatorExternalId,
    source_product_id: null,
    title,
    teaser,
    official_url: officialUrl,
    thumbnail_url: thumbnailUrl,
    published_at: publishedAt,
    content_type: mediaIndicator === "unknown" ? "unknown" : mediaIndicator,
    media_indicator: mediaIndicator,
    sample_available: null,
    visibility: "public",
    price: null,
    currency: "JPY",
    review_status: "public_metadata_staged",
  } : null;
  return recordEnvelope({
    entityType: "post", externalId: postId, creatorExternalId, sourceUrl: canonicalSource,
    officialUrl, fetchedAt, visibility: "public", normalized, rawPublicMetadata,
    sourcePageHash: pageHash,
    classification: safe ? MYFANS_CLASSIFICATIONS.SAFE : MYFANS_CLASSIFICATIONS.REVIEW,
    reasonCodes: safe ? ["ANONYMOUS_HTTP_200", "STABLE_POST_ID", "KNOWN_CREATOR", sourceKind.toUpperCase()] : [creatorKnown ? "PUBLIC_POST_METADATA_INCOMPLETE" : "CREATOR_IDENTITY_NOT_CONFIRMED"],
  });
}

export function discoverPublicLinks(html, baseUrl = MYFANS_ORIGIN) {
  const { links } = extractPublicMetadata(html, baseUrl);
  return {
    creator_urls: links.filter((url) => creatorSlugFromUrl(url)),
    post_urls: links.filter((url) => postIdFromUrl(url)),
  };
}

export function dedupeFrozenRecords(records) {
  const seenIds = new Set();
  const seenUrls = new Set();
  return records.map((record) => {
    const idKey = `${record.entity_type}:${record.external_id ?? "missing"}`;
    const urlKey = record.official_url ?? record.source_url;
    if (record.external_id && seenIds.has(idKey)) return { ...record, classification: MYFANS_CLASSIFICATIONS.DUPLICATE, reason_codes: ["DUPLICATE_STABLE_ID"] };
    if (urlKey && seenUrls.has(urlKey)) return { ...record, classification: MYFANS_CLASSIFICATIONS.DUPLICATE, reason_codes: ["DUPLICATE_OFFICIAL_URL"] };
    if (record.external_id) seenIds.add(idKey);
    if (urlKey) seenUrls.add(urlKey);
    return record;
  });
}

function isOfficialHtmlUrl(value) {
  const canonical = canonicalizeMyFansUrl(value, MYFANS_ORIGIN, { allowRoot: true });
  if (!canonical) return false;
  const pathname = new URL(canonical).pathname.toLowerCase();
  return !/\.(?:avif|gif|jpe?g|png|svg|webp|mp4|m3u8|mov|webm)(?:$|\/)/.test(pathname);
}

async function readHtmlBody(response, maxHtmlBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxHtmlBytes) throw new Error("HTML_RESPONSE_TOO_LARGE");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let value = "";
  try {
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      bytes += chunk.byteLength;
      if (bytes > maxHtmlBytes) {
        await reader.cancel();
        throw new Error("HTML_RESPONSE_TOO_LARGE");
      }
      value += decoder.decode(chunk, { stream: true });
    }
    value += decoder.decode();
    return value;
  } finally {
    reader.releaseLock();
  }
}

export function createPublicHtmlFetcher({ fetchImpl = globalThis.fetch, maxRequests = 40, maxRetries = 1, maxHtmlBytes = 2_000_000, userAgent = "OkazuDB-MyFans-Public-Metadata-Pilot/1.0" } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");
  if (maxRequests > 40 || maxRequests < 1) throw new Error("REQUEST_BUDGET_INVALID");
  if (maxRetries > 1 || maxRetries < 0) throw new Error("RETRY_BUDGET_INVALID");
  if (!Number.isInteger(maxHtmlBytes) || maxHtmlBytes < 1 || maxHtmlBytes > 5_000_000) throw new Error("HTML_SIZE_LIMIT_INVALID");
  const completedUrls = new Set();
  const inFlightUrls = new Set();
  const requests = [];
  let initialRequests = 0;
  let retryRequests = 0;

  async function fetchHtml(value, { label = null } = {}) {
    const url = canonicalizeMyFansUrl(value, MYFANS_ORIGIN, { allowRoot: true });
    if (!url || !isOfficialHtmlUrl(url)) throw new Error("NON_PUBLIC_HTML_URL_REJECTED");
    if (completedUrls.has(url) || inFlightUrls.has(url)) throw new Error(`DUPLICATE_REQUEST_URL_BLOCKED:${url}`);
    inFlightUrls.add(url);
    try {
      let lastError;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        if (requests.length >= maxRequests) throw new Error("REQUEST_BUDGET_EXCEEDED");
        if (attempt === 0) initialRequests += 1;
        else retryRequests += 1;
        const startedAt = new Date().toISOString();
        try {
          const response = await fetchImpl(url, {
            method: "GET",
            redirect: "manual",
            credentials: "omit",
            headers: { accept: "text/html,application/xhtml+xml", "user-agent": userAgent },
          });
          const contentType = response.headers.get("content-type") ?? "";
          const location = response.headers.get("location");
          let html = "";
          if (response.status === 200) {
            if (!/^text\/html\b|^application\/xhtml\+xml\b/i.test(contentType)) throw new Error("NON_HTML_RESPONSE_REJECTED");
            html = await readHtmlBody(response, maxHtmlBytes);
          }
          requests.push({ url, label, attempt, started_at: startedAt, status: response.status, content_type: contentType.split(";")[0], location: location ? "present" : null });
          completedUrls.add(url);
          return { url, response_url: canonicalizeMyFansUrl(response.url || url, url, { allowRoot: true }) ?? url, status: response.status, content_type: contentType, location, html, fetched_at: new Date().toISOString() };
        } catch (error) {
          lastError = error;
          requests.push({ url, label, attempt, started_at: startedAt, status: null, error_code: error?.message ?? "NETWORK_ERROR" });
          if (attempt >= maxRetries || !(error instanceof TypeError)) break;
        }
      }
      completedUrls.add(url);
      throw lastError;
    } finally {
      inFlightUrls.delete(url);
    }
  }

  function summary() {
    return {
      request_budget: maxRequests,
      actual_requests: requests.length,
      initial_requests: initialRequests,
      retry_requests: retryRequests,
      unique_urls: completedUrls.size,
      duplicate_requests: 0,
      image_body_gets: 0,
      video_gets: 0,
      authenticated_gets: 0,
      private_api_gets: 0,
      requests: requests.map(({ url, label, attempt, status, content_type, error_code }) => ({ url, label, attempt, status, content_type, error_code })),
    };
  }

  return { fetchHtml, summary };
}

export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeFrozenJsonlGzip(file, records) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.jsonl`;
  await writeFile(temporary, records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""));
  await pipeline(createReadStream(temporary), createGzip({ level: 9 }), createWriteStream(file));
  await import("node:fs/promises").then(({ unlink }) => unlink(temporary));
}

export async function readFrozenJsonlGzip(file) {
  const value = gunzipSync(await readFile(file)).toString("utf8").trim();
  return value ? value.split("\n").map((line) => JSON.parse(line)) : [];
}

export function assertNoRawHtmlPersisted(value) {
  const serialized = JSON.stringify(value);
  if (/<(?:!doctype|html|head|body|script|meta)\b/i.test(serialized)) throw new Error("RAW_HTML_PERSISTENCE_BLOCKED");
  return value;
}

export function planStagingChanges(records, existingRows, { targetDataSourceId = null, targetSourceAbsent = false } = {}) {
  const idCounts = new Map();
  const urlCounts = new Map();
  for (const row of existingRows) {
    idCounts.set(row.external_id, (idCounts.get(row.external_id) ?? 0) + 1);
    urlCounts.set(row.official_url, (urlCounts.get(row.official_url) ?? 0) + 1);
  }
  const existingById = new Map(existingRows.map((row) => [row.external_id, row]));
  const existingByUrl = new Map(existingRows.map((row) => [row.official_url, row]));
  return records.map((record) => {
    if (record.classification !== MYFANS_CLASSIFICATIONS.SAFE || !record.normalized) {
      return { external_id: record.external_id, state: "CONFLICT", reason: "NOT_PUBLIC_SAFE_METADATA", record };
    }
    const byId = existingById.get(record.external_id);
    const byUrl = existingByUrl.get(record.official_url);
    if ((idCounts.get(record.external_id) ?? 0) > 1 || (urlCounts.get(record.official_url) ?? 0) > 1) {
      return { external_id: record.external_id, state: "CONFLICT", reason: "MULTIPLE_EXISTING_IDENTITY_ROWS", record };
    }
    if (byUrl && byUrl.external_id !== record.external_id) {
      return { external_id: record.external_id, state: "CONFLICT", reason: "OFFICIAL_URL_ID_CONFLICT", record, existing: byUrl };
    }
    if (!byId) return { external_id: record.external_id, state: "NEW", reason: "TARGET_ABSENT", record };
    if (targetSourceAbsent) {
      return { external_id: record.external_id, state: "CONFLICT", reason: "ROW_EXISTS_WITHOUT_TARGET_SOURCE", record, existing: byId };
    }
    if (targetDataSourceId && byId.data_source_id !== targetDataSourceId) {
      return { external_id: record.external_id, state: "CONFLICT", reason: "DATA_SOURCE_CONFLICT", record, existing: byId };
    }
    const exact = byId.official_url === record.official_url
      && byId.metadata_hash === record.metadata_hash
      && byId.visibility === "public"
      && byId.review_status === "public_metadata_staged"
      && (record.entity_type !== "post" || byId.creator_external_id === record.creator_external_id);
    return exact
      ? { external_id: record.external_id, state: "UNCHANGED", reason: "EXACT_FROZEN_MATCH", record, existing: byId }
      : { external_id: record.external_id, state: "EXISTING_CHANGED", reason: "EXISTING_ROW_DIFFERS", record, existing: byId };
  });
}

export function summarizeStagingPlan(plan) {
  return Object.fromEntries(["NEW", "UNCHANGED", "EXISTING_CHANGED", "CONFLICT"].map((state) => [state, plan.filter((entry) => entry.state === state).length]));
}
