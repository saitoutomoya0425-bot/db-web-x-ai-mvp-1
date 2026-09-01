#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createCloudStateClientFromEnv,
  deleteExactObjects,
  downloadExactObject,
  listExactPrefix,
  readRemoteStateIndex,
  resolveStateRoot,
  restoreExactStateFile,
  sha256,
  syncExactStateFile,
  uploadExactObject,
  validateLogicalPath,
} from "../lib/okazu-cloud-state.mjs";

const COMMAND_OPTIONS = {
  preflight: new Set([]),
  sync: new Set(["category", "canonical", "logical-path", "source", "source-phase", "status", "updated-at"]),
  restore: new Set(["logical-path"]),
  list: new Set(["prefix"]),
  index: new Set([]),
  smoke: new Set([]),
};

function parseOptions(command, input) {
  const allowed = COMMAND_OPTIONS[command];
  if (!allowed) throw new Error("UNKNOWN_CLOUD_STATE_OPERATION");
  const options = {};
  for (let index = 0; index < input.length; index += 2) {
    const flag = input[index];
    const value = input[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("CLOUD_STATE_OPTION_INVALID");
    const name = flag.slice(2);
    if (!allowed.has(name) || Object.hasOwn(options, name)) throw new Error("CLOUD_STATE_OPTION_REJECTED");
    options[name] = value;
  }
  return options;
}

function required(options, name) {
  const value = String(options[name] ?? "").trim();
  if (!value) throw new Error(`CLOUD_STATE_${name.toUpperCase().replaceAll("-", "_")}_REQUIRED`);
  return value;
}

function printSafe(value, output) {
  output.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function runCloudStateCli(argv, {
  env = process.env,
  cwd = process.cwd(),
  output = process.stdout,
  clientFactory = createCloudStateClientFromEnv,
} = {}) {
  const [command, ...optionInput] = argv;
  const options = parseOptions(command, optionInput);
  const stateRoot = resolveStateRoot({ env, cwd });

  if (command === "preflight") {
    const requiredNames = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
    printSafe({
      operation: command,
      state_root: stateRoot,
      required_names: requiredNames,
      present_names: requiredNames.filter((name) => Boolean(env[name])),
      missing_names: requiredNames.filter((name) => !env[name]),
      production_write_enabled: false,
    }, output);
    return;
  }

  const client = clientFactory(env);
  if (command === "sync") {
    const source = validateLogicalPath(required(options, "source"));
    const logicalPath = validateLogicalPath(options["logical-path"] || source);
    const entry = await syncExactStateFile({
      client,
      stateRoot,
      sourcePath: path.resolve(stateRoot, ...source.split("/")),
      logicalPath,
      metadata: {
        category: required(options, "category"),
        canonical: String(options.canonical ?? "false").toLowerCase() === "true",
        status: required(options, "status"),
        source_phase: required(options, "source-phase"),
        updated_at: options["updated-at"],
      },
    });
    printSafe({ operation: command, result: entry }, output);
    return;
  }

  if (command === "restore") {
    const logicalPath = required(options, "logical-path");
    const restored = await restoreExactStateFile({ client, stateRoot, logicalPath });
    printSafe({
      operation: command,
      logical_path: restored.logical_path,
      sha256: restored.sha256,
      size: restored.size,
    }, output);
    return;
  }

  if (command === "list") {
    const prefix = options.prefix ? validateLogicalPath(options.prefix) : "";
    const rows = await listExactPrefix(client, prefix);
    printSafe({ operation: command, prefix, objects: rows }, output);
    return;
  }

  if (command === "index") {
    const entries = await readRemoteStateIndex(client);
    printSafe({
      operation: command,
      entries: entries.length,
      bytes: entries.reduce((total, entry) => total + entry.size, 0),
      canonical_entries: entries.filter((entry) => entry.canonical).length,
    }, output);
    return;
  }

  if (command === "smoke") {
    const logicalPath = "smoke/codex-cloud-state-smoke.json";
    const bytes = Buffer.from(`${JSON.stringify({ synthetic: true, business_data: false, personal_data: false })}\n`);
    let uploaded = false;
    try {
      await uploadExactObject(client, logicalPath, bytes, { upsert: false });
      uploaded = true;
      const restored = await downloadExactObject(client, logicalPath);
      if (sha256(bytes) !== sha256(restored)) throw new Error("STATE_SMOKE_SHA_MISMATCH");
      printSafe({ operation: command, upload: "PASS", download: "PASS", sha256: "PASS" }, output);
    } finally {
      if (uploaded) await deleteExactObjects(client, [logicalPath]);
    }
    return;
  }

  throw new Error("UNKNOWN_CLOUD_STATE_OPERATION");
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  runCloudStateCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
