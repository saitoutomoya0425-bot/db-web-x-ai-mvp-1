#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertNoConfiguredSecretValues,
  createCloudStateClientFromEnv,
  inspectExactStateFile,
  MAX_STATE_FILE_BYTES,
  resolveStateRoot,
  syncInspectedStateFiles,
} from "../lib/okazu-cloud-state.mjs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDirectory, "../..");
const manifestPath = path.join(repoRoot, "config", "codex-cloud-state-restore.json");

export async function syncCodexCloudState({ env = process.env, output = process.stdout, dryRun = false } = {}) {
  const stateRoot = resolveStateRoot({ env, cwd: repoRoot });
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (manifest?.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("CODEX_CLOUD_STATE_MANIFEST_INVALID");
  }

  const inspected = [];
  let totalBytes = 0;
  for (const item of manifest.files) {
    if (item.source !== item.logical_path) throw new Error("CODEX_CLOUD_STATE_SOURCE_MUST_MATCH_LOGICAL_PATH");
    const result = await inspectExactStateFile({
      stateRoot,
      sourcePath: path.resolve(stateRoot, ...item.source.split("/")),
      logicalPath: item.logical_path,
      metadata: item,
    });
    assertNoConfiguredSecretValues(result.bytes, env);
    inspected.push({ item, result });
    totalBytes += result.bytes.length;
  }
  if (totalBytes > MAX_STATE_FILE_BYTES) throw new Error("CODEX_CLOUD_STATE_SELECTION_EXCEEDS_50_MIB");

  if (dryRun) {
    const result = {
      dry_run: true,
      files_selected: inspected.length,
      bytes_selected: totalBytes,
      selection_under_50_mib: true,
      secret_values_serialized: 0,
      remote_writes: 0,
    };
    output.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }

  const client = createCloudStateClientFromEnv(env);
  const synced = await syncInspectedStateFiles({
    client,
    files: inspected.map(({ result }) => result),
  });

  const result = {
    state_backend: "supabase-private-storage",
    bucket: client.bucket,
    files_synced: synced.length,
    bytes_synced: totalBytes,
    sha256_verified: synced.length,
    secret_values_serialized: 0,
    local_files_deleted: 0,
  };
  output.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  const args = process.argv.slice(2);
  const dryRun = args.length === 1 && args[0] === "--dry-run";
  if (args.length && !dryRun) {
    process.stderr.write("UNKNOWN_CLOUD_STATE_SYNC_OPTION\n");
    process.exitCode = 1;
  } else {
    syncCodexCloudState({ dryRun }).catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
  }
}
