#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  atomicWriteFile,
  createCloudStateClientFromEnv,
  readRemoteStateIndex,
  resolveStateRoot,
  restoreExactStateFile,
  sha256,
} from "../lib/okazu-cloud-state.mjs";

const execFileAsync = promisify(execFile);
const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(MODULE_DIRECTORY, "../..");
const PRODUCTION_WRITE_FLAGS = [
  "ALLOW_PRODUCTION_WRITE",
  "OKAZU_PRODUCTION_WRITE_ENABLED",
  "PRODUCTION_MUTATION_ENABLED",
];

function isTruthy(value) {
  return ["1", "true", "yes"].includes(String(value ?? "").trim().toLowerCase());
}

function parseRequiredNames(value) {
  const names = String(value ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  if (!names.every((name) => /^[A-Z][A-Z0-9_]*$/.test(name))) {
    throw new Error("CLOUD_REQUIRED_ENV_NAMES_INVALID");
  }
  return [...new Set(names)].sort();
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function defaultInstall(repoRoot) {
  await execFileAsync("npm", ["ci", "--no-audit", "--no-fund"], {
    cwd: repoRoot,
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  });
}

export async function runCodexCloudSetup({
  env = process.env,
  repoRoot = DEFAULT_REPO_ROOT,
  nodeVersion = process.versions.node,
  install = defaultInstall,
  output = process.stdout,
} = {}) {
  const startedAt = new Date().toISOString();
  const nodeMajor = Number.parseInt(String(nodeVersion).split(".")[0], 10);
  if (nodeMajor !== 22) throw new Error(`CODEX_CLOUD_NODE_MISMATCH:${nodeVersion}`);

  const enabledWriteFlag = PRODUCTION_WRITE_FLAGS.find((name) => isTruthy(env[name]));
  if (enabledWriteFlag) throw new Error(`CODEX_CLOUD_PRODUCTION_WRITE_BLOCKED:${enabledWriteFlag}`);

  const root = path.resolve(repoRoot);
  const lockPath = path.join(root, "package-lock.json");
  if (!await exists(lockPath)) throw new Error("CODEX_CLOUD_PACKAGE_LOCK_REQUIRED");
  const lockHash = sha256(await fs.readFile(lockPath));
  const cacheRoot = path.join(root, ".codex-cloud-cache");
  const markerPath = path.join(cacheRoot, "npm-lock.sha256");
  const modulesPath = path.join(root, "node_modules");
  let marker = "";
  try {
    marker = (await fs.readFile(markerPath, "utf8")).trim();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  let dependencies = "cached";
  if (marker !== lockHash || !await exists(modulesPath)) {
    if (isTruthy(env.CODEX_CLOUD_SKIP_INSTALL)) {
      dependencies = "skipped_by_explicit_test_flag";
    } else {
      await install(root);
      await fs.mkdir(cacheRoot, { recursive: true });
      await atomicWriteFile(markerPath, `${lockHash}\n`);
      dependencies = "installed";
    }
  }

  const stateRoot = resolveStateRoot({ env, cwd: root });
  await fs.mkdir(stateRoot, { recursive: true });

  const restoreEnabled = isTruthy(env.OKAZU_CLOUD_RESTORE_STATE);
  const requiredNames = parseRequiredNames(env.CODEX_CLOUD_REQUIRED_ENV_NAMES);
  if (restoreEnabled) requiredNames.push("NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY");
  const uniqueRequiredNames = [...new Set(requiredNames)].sort();
  const missingNames = uniqueRequiredNames.filter((name) => !env[name]);
  if (missingNames.length) throw new Error(`CODEX_CLOUD_REQUIRED_ENV_MISSING:${missingNames.join(",")}`);

  const restored = [];
  if (restoreEnabled) {
    const manifestPath = path.join(root, "config", "codex-cloud-state-restore.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    if (manifest?.version !== 1 || !Array.isArray(manifest.files)) {
      throw new Error("CODEX_CLOUD_RESTORE_MANIFEST_INVALID");
    }
    const client = createCloudStateClientFromEnv(env);
    const indexEntries = await readRemoteStateIndex(client);
    for (const item of manifest.files) {
      const result = await restoreExactStateFile({
        client,
        stateRoot,
        logicalPath: item.logical_path,
        indexEntries,
      });
      restored.push({ logical_path: result.logical_path, sha256: result.sha256, size: result.size });
    }
  }

  const result = {
    codex_cloud_setup: "PASS",
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    node: `v${nodeVersion}`,
    dependencies,
    state_root: stateRoot,
    state_restore_enabled: restoreEnabled,
    state_files_restored: restored.length,
    required_env_names: uniqueRequiredNames,
    missing_env_names: [],
    production_write_enabled: false,
  };
  output.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  runCodexCloudSetup().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
