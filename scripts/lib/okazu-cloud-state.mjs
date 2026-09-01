import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_STATE_BUCKET = "okazudb-state-private";
export const STATE_INDEX_PATH = "cloud-state-index.json";
export const MAX_STATE_FILE_BYTES = 50 * 1024 * 1024;

const MEDIA_EXTENSIONS = new Set([
  ".avif", ".bmp", ".gif", ".heic", ".jpeg", ".jpg", ".mov", ".mp3",
  ".mp4", ".mpeg", ".pdf", ".png", ".tif", ".tiff", ".wav", ".webm", ".webp",
]);
const RAW_HTML_EXTENSIONS = new Set([".htm", ".html", ".mhtml"]);
const CACHE_SEGMENTS = new Set([
  ".cache", ".next", "browser-profile", "cache", "node_modules", "profiles", "tmp",
]);
const SECRET_SEGMENT = /(^\.env(?:\.|$)|api[-_.]?key|auth(?:orization)?|cookie|credential|password|passwd|private[-_.]?key|secret|service[-_.]?role|session|(^|[-_.])token($|[-_.]))/i;
const SECRET_EXTENSIONS = new Set([".key", ".p12", ".pem"]);
const UPLOADABLE_CATEGORIES = new Set(["ACTIVE_CANONICAL", "ACTIVE_SUPPORTING", "HISTORICAL_SUMMARY"]);

function isTruthy(value) {
  return ["1", "true", "yes"].includes(String(value ?? "").trim().toLowerCase());
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function resolveStateRoot({ env = process.env, homedir = os.homedir(), cwd = process.cwd() } = {}) {
  const configured = String(env.OKAZU_STATE_ROOT ?? "").trim();
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error("OKAZU_STATE_ROOT_MUST_BE_ABSOLUTE");
    return path.normalize(configured);
  }
  if (isTruthy(env.CODEX_CLOUD)) {
    const cloudBase = String(env.RUNNER_TEMP ?? "").trim();
    return cloudBase
      ? path.resolve(cloudBase, "okazudb-state")
      : path.resolve(cwd, ".codex-state");
  }
  return path.join(homedir, "Documents", "Codex", "okazudb-state");
}

export function validateLogicalPath(value, { allowIndex = true } = {}) {
  const logicalPath = String(value ?? "");
  if (!logicalPath || logicalPath.includes("\0") || logicalPath.includes("\\")) {
    throw new Error("STATE_PATH_INVALID");
  }
  if (path.posix.isAbsolute(logicalPath) || logicalPath.startsWith("./") || logicalPath.endsWith("/")) {
    throw new Error("STATE_PATH_MUST_BE_RELATIVE");
  }
  const segments = logicalPath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("STATE_PATH_TRAVERSAL_REJECTED");
  }
  if (!segments.every((segment) => /^(?:[A-Za-z0-9][A-Za-z0-9._-]*|\.[A-Za-z0-9][A-Za-z0-9._-]*)$/.test(segment))) {
    throw new Error("STATE_PATH_UNSAFE_CHARACTERS");
  }
  if (!allowIndex && logicalPath === STATE_INDEX_PATH) throw new Error("STATE_INDEX_PATH_RESERVED");
  return logicalPath;
}

export function statePathExclusionReason(value) {
  const logicalPath = validateLogicalPath(value);
  const segments = logicalPath.split("/");
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const extension = path.posix.extname(logicalPath).toLowerCase();
  if (logicalPath !== STATE_INDEX_PATH && lowerSegments.some((segment) => SECRET_SEGMENT.test(segment))) {
    return "SECRET_PATH";
  }
  if (SECRET_EXTENSIONS.has(extension)) return "SECRET_PATH";
  if (lowerSegments.some((segment) => CACHE_SEGMENTS.has(segment))) return "CACHE_PATH";
  if (RAW_HTML_EXTENSIONS.has(extension)) return "RAW_HTML";
  if (MEDIA_EXTENSIONS.has(extension)) return "IMAGE_OR_MEDIA";
  return null;
}

export function assertUploadableLogicalPath(value) {
  const logicalPath = validateLogicalPath(value, { allowIndex: false });
  const reason = statePathExclusionReason(logicalPath);
  if (reason) throw new Error(`STATE_UPLOAD_REJECTED_${reason}`);
  return logicalPath;
}

export function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function assertNoConfiguredSecretValues(input, env = process.env) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const secretNamePattern = /(ADMIN_EMAIL|ADMIN_PASSWORD|API_(?:ID|KEY)|AUTHORIZATION|COOKIE|CREDENTIAL|FANZA_AFFILIATE_ID|PASSWORD|PRIVATE_KEY|SECRET|SERVICE_ROLE|SESSION|(?:^|_)KEY(?:_|$)|TOKEN)/i;
  const matches = Object.entries(env)
    .filter(([name, value]) => secretNamePattern.test(name) && typeof value === "string" && value.length >= 12)
    .filter(([, value]) => bytes.includes(Buffer.from(value)))
    .map(([name]) => name)
    .sort();
  if (matches.length) throw new Error(`STATE_SECRET_VALUE_REJECTED:${matches.join(",")}`);
}

function normalizeIso(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error("STATE_UPDATED_AT_INVALID");
  return date.toISOString();
}

function normalizeIndexEntry(entry) {
  const logicalPath = assertUploadableLogicalPath(entry.logical_path);
  const digest = String(entry.sha256 ?? "").toLowerCase();
  const size = Number(entry.size);
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("STATE_SHA256_INVALID");
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_STATE_FILE_BYTES) {
    throw new Error("STATE_SIZE_INVALID");
  }
  const category = String(entry.category ?? "");
  const status = String(entry.status ?? "");
  const sourcePhase = String(entry.source_phase ?? "");
  if (!UPLOADABLE_CATEGORIES.has(category)) throw new Error("STATE_CATEGORY_NOT_UPLOADABLE");
  if (!status || !sourcePhase) throw new Error("STATE_INDEX_METADATA_REQUIRED");
  return {
    logical_path: logicalPath,
    sha256: digest,
    size,
    updated_at: normalizeIso(entry.updated_at),
    category,
    canonical: Boolean(entry.canonical),
    status,
    source_phase: sourcePhase,
  };
}

export function serializeStateIndex(entries) {
  if (!Array.isArray(entries)) throw new Error("STATE_INDEX_ENTRIES_REQUIRED");
  const normalized = entries.map(normalizeIndexEntry).sort((left, right) => (
    left.logical_path < right.logical_path ? -1 : left.logical_path > right.logical_path ? 1 : 0
  ));
  if (new Set(normalized.map((entry) => entry.logical_path)).size !== normalized.length) {
    throw new Error("STATE_INDEX_DUPLICATE_PATH");
  }
  return `${JSON.stringify({ version: 1, entries: normalized }, null, 2)}\n`;
}

export function parseStateIndex(input) {
  const parsed = JSON.parse(Buffer.isBuffer(input) ? input.toString("utf8") : String(input));
  if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) throw new Error("STATE_INDEX_INVALID");
  return JSON.parse(serializeStateIndex(parsed.entries)).entries;
}

export async function atomicWriteFile(targetPath, data, { mode = 0o600 } = {}) {
  const directory = path.dirname(targetPath);
  await fs.mkdir(directory, { recursive: true });
  const realDirectory = await fs.realpath(directory);
  const resolvedTarget = path.join(realDirectory, path.basename(targetPath));
  if (!isWithin(realDirectory, resolvedTarget)) throw new Error("STATE_ATOMIC_TARGET_INVALID");
  try {
    const current = await fs.lstat(resolvedTarget);
    if (current.isSymbolicLink()) throw new Error("STATE_SYMLINK_TARGET_REJECTED");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporaryPath = path.join(directory, `.${path.basename(targetPath)}.${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporaryPath, data, { mode, flag: "wx" });
    await fs.rename(temporaryPath, resolvedTarget);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export async function inspectExactStateFile({ stateRoot, sourcePath, logicalPath, metadata }) {
  const root = path.resolve(stateRoot);
  const source = path.resolve(sourcePath);
  if (!isWithin(root, source)) throw new Error("STATE_SOURCE_OUTSIDE_ROOT");
  const rootReal = await fs.realpath(root);
  const sourceReal = await fs.realpath(source);
  if (!isWithin(rootReal, sourceReal)) throw new Error("STATE_SOURCE_SYMLINK_ESCAPE");
  const file = await fs.lstat(source);
  if (!file.isFile() || file.isSymbolicLink()) throw new Error("STATE_SOURCE_NOT_REGULAR_FILE");
  if (file.size > MAX_STATE_FILE_BYTES) throw new Error("STATE_FILE_TOO_LARGE");
  const safeLogicalPath = assertUploadableLogicalPath(logicalPath);
  const bytes = await fs.readFile(source);
  return {
    bytes,
    entry: normalizeIndexEntry({
      logical_path: safeLogicalPath,
      sha256: sha256(bytes),
      size: bytes.length,
      updated_at: metadata.updated_at ?? file.mtime.toISOString(),
      category: metadata.category,
      canonical: metadata.canonical,
      status: metadata.status,
      source_phase: metadata.source_phase,
    }),
  };
}

function encodeObjectPath(logicalPath) {
  return validateLogicalPath(logicalPath).split("/").map(encodeURIComponent).join("/");
}

function storageUrl(client, operation, logicalPath = "") {
  const suffix = logicalPath ? `/${encodeObjectPath(logicalPath)}` : "";
  return new URL(`/storage/v1/${operation}/${encodeURIComponent(client.bucket)}${suffix}`, client.baseUrl);
}

function safeHeaders(client, extra = {}) {
  return {
    apikey: client.serviceRoleKey,
    Authorization: `Bearer ${client.serviceRoleKey}`,
    ...extra,
  };
}

async function request(client, { operation, logicalPath, method = "GET", body, headers, allowMissing = false }) {
  const response = await client.fetchImpl(storageUrl(client, operation, logicalPath), {
    method,
    headers: safeHeaders(client, headers),
    body,
  });
  if (!response.ok) {
    if (allowMissing && [400, 404].includes(response.status)) return null;
    throw new Error(`STATE_STORAGE_${method}_FAILED_${response.status}`);
  }
  return response;
}

export function createCloudStateClient({
  baseUrl,
  serviceRoleKey,
  bucket = DEFAULT_STATE_BUCKET,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!baseUrl || !serviceRoleKey) throw new Error("STATE_STORAGE_CREDENTIAL_NAMES_MISSING");
  if (typeof fetchImpl !== "function") throw new Error("STATE_STORAGE_FETCH_UNAVAILABLE");
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "https:") throw new Error("STATE_STORAGE_HTTPS_REQUIRED");
  if (!parsed.hostname.endsWith(".supabase.co") || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("STATE_STORAGE_ORIGIN_REJECTED");
  }
  if (bucket !== DEFAULT_STATE_BUCKET) throw new Error("STATE_STORAGE_BUCKET_REJECTED");
  return { baseUrl: parsed, serviceRoleKey, bucket, fetchImpl };
}

export function createCloudStateClientFromEnv(env = process.env, options = {}) {
  return createCloudStateClient({
    baseUrl: env.NEXT_PUBLIC_SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    bucket: env.OKAZU_STATE_BUCKET || DEFAULT_STATE_BUCKET,
    ...options,
  });
}

function contentTypeFor(logicalPath) {
  const extension = path.posix.extname(logicalPath).toLowerCase();
  if (extension === ".json") return "application/json";
  if (extension === ".csv") return "text/csv";
  if (extension === ".md") return "text/markdown";
  if (extension === ".txt") return "text/plain";
  if (extension === ".gz") return "application/gzip";
  return "application/octet-stream";
}

export async function uploadExactObject(client, logicalPath, bytes, { upsert = false } = {}) {
  const safePath = logicalPath === STATE_INDEX_PATH
    ? validateLogicalPath(logicalPath)
    : assertUploadableLogicalPath(logicalPath);
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (body.length > MAX_STATE_FILE_BYTES) throw new Error("STATE_FILE_TOO_LARGE");
  await request(client, {
    operation: "object",
    logicalPath: safePath,
    method: "POST",
    body,
    headers: {
      "Content-Type": contentTypeFor(safePath),
      "x-upsert": upsert ? "true" : "false",
    },
  });
  return { logical_path: safePath, size: body.length, sha256: sha256(body) };
}

export async function downloadExactObject(client, logicalPath, { allowMissing = false } = {}) {
  const safePath = validateLogicalPath(logicalPath);
  const response = await request(client, {
    operation: "object",
    logicalPath: safePath,
    allowMissing,
  });
  return response ? Buffer.from(await response.arrayBuffer()) : null;
}

export async function deleteExactObjects(client, logicalPaths) {
  if (!Array.isArray(logicalPaths) || logicalPaths.length === 0) throw new Error("STATE_DELETE_PATHS_REQUIRED");
  const prefixes = logicalPaths.map((logicalPath) => validateLogicalPath(logicalPath));
  await request(client, {
    operation: "object",
    method: "DELETE",
    body: JSON.stringify({ prefixes }),
    headers: { "Content-Type": "application/json" },
  });
}

export async function listExactPrefix(client, prefix) {
  const safePrefix = prefix === "" ? "" : validateLogicalPath(prefix).replace(/\/[^/]*$/, "");
  const response = await request(client, {
    operation: "object/list",
    method: "POST",
    body: JSON.stringify({ prefix: safePrefix, limit: 1000, offset: 0, sortBy: { column: "name", order: "asc" } }),
    headers: { "Content-Type": "application/json" },
  });
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("STATE_STORAGE_LIST_INVALID");
  return rows.map((row) => ({ name: String(row.name), id: row.id ?? null }));
}

export async function readRemoteStateIndex(client) {
  const bytes = await downloadExactObject(client, STATE_INDEX_PATH, { allowMissing: true });
  return bytes ? parseStateIndex(bytes) : [];
}

export async function syncExactStateFile({ client, stateRoot, sourcePath, logicalPath, metadata }) {
  const inspected = await inspectExactStateFile({ stateRoot, sourcePath, logicalPath, metadata });
  await uploadExactObject(client, inspected.entry.logical_path, inspected.bytes, { upsert: true });
  const current = await readRemoteStateIndex(client);
  const entries = current.filter((entry) => entry.logical_path !== inspected.entry.logical_path);
  entries.push(inspected.entry);
  const indexBytes = Buffer.from(serializeStateIndex(entries));
  await uploadExactObject(client, STATE_INDEX_PATH, indexBytes, { upsert: true });
  return inspected.entry;
}

export async function syncInspectedStateFiles({ client, files }) {
  if (!Array.isArray(files) || files.length === 0) throw new Error("STATE_SYNC_FILES_REQUIRED");
  const current = await readRemoteStateIndex(client);
  const replacements = new Map();
  for (const file of files) {
    const entry = normalizeIndexEntry(file.entry);
    if (replacements.has(entry.logical_path)) throw new Error("STATE_SYNC_DUPLICATE_PATH");
    if (sha256(file.bytes) !== entry.sha256 || file.bytes.length !== entry.size) {
      throw new Error("STATE_SYNC_INSPECTION_MISMATCH");
    }
    replacements.set(entry.logical_path, { bytes: file.bytes, entry });
  }
  for (const { bytes, entry } of replacements.values()) {
    await uploadExactObject(client, entry.logical_path, bytes, { upsert: true });
  }
  const entries = current.filter((entry) => !replacements.has(entry.logical_path));
  entries.push(...[...replacements.values()].map(({ entry }) => entry));
  await uploadExactObject(client, STATE_INDEX_PATH, Buffer.from(serializeStateIndex(entries)), { upsert: true });
  return [...replacements.values()].map(({ entry }) => entry);
}

export async function restoreExactStateFile({ client, stateRoot, logicalPath, indexEntries }) {
  const safePath = assertUploadableLogicalPath(logicalPath);
  const entries = indexEntries ?? await readRemoteStateIndex(client);
  const expected = entries.find((entry) => entry.logical_path === safePath);
  if (!expected) throw new Error("STATE_INDEX_ENTRY_NOT_FOUND");
  const bytes = await downloadExactObject(client, safePath);
  if (bytes.length !== expected.size || sha256(bytes) !== expected.sha256) {
    throw new Error("STATE_DOWNLOAD_INTEGRITY_FAILED");
  }
  const root = path.resolve(stateRoot);
  await fs.mkdir(root, { recursive: true });
  const rootReal = await fs.realpath(root);
  const target = path.resolve(root, ...safePath.split("/"));
  if (!isWithin(root, target)) throw new Error("STATE_DESTINATION_OUTSIDE_ROOT");
  await fs.mkdir(path.dirname(target), { recursive: true });
  const parentReal = await fs.realpath(path.dirname(target));
  if (!isWithin(rootReal, parentReal)) throw new Error("STATE_DESTINATION_SYMLINK_ESCAPE");
  await atomicWriteFile(target, bytes);
  return { ...expected, local_path: target };
}
