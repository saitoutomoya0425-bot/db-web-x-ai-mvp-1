import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCloudStateCli } from "../scripts/cloud/okazu-cloud-state.mjs";
import {
  assertNoConfiguredSecretValues,
  assertUploadableLogicalPath,
  atomicWriteFile,
  createCloudStateClient,
  inspectExactStateFile,
  parseStateIndex,
  resolveStateRoot,
  serializeStateIndex,
  sha256,
  statePathExclusionReason,
  validateLogicalPath,
} from "../scripts/lib/okazu-cloud-state.mjs";

test("state root preserves the local default and supports exact cloud overrides", () => {
  assert.equal(
    resolveStateRoot({ env: {}, homedir: "/Users/example", cwd: "/repo" }),
    "/Users/example/Documents/Codex/okazudb-state",
  );
  assert.equal(
    resolveStateRoot({ env: { OKAZU_STATE_ROOT: "/private/state" }, homedir: "/Users/example", cwd: "/repo" }),
    "/private/state",
  );
  assert.equal(
    resolveStateRoot({ env: { CODEX_CLOUD: "true", RUNNER_TEMP: "/runner" }, cwd: "/repo" }),
    "/runner/okazudb-state",
  );
  assert.equal(
    resolveStateRoot({ env: { CODEX_CLOUD: "true" }, cwd: "/repo" }),
    "/repo/.codex-state",
  );
  assert.throws(() => resolveStateRoot({ env: { OKAZU_STATE_ROOT: "relative" } }), /MUST_BE_ABSOLUTE/);
});

test("state paths are exact and traversal is rejected", () => {
  assert.equal(validateLogicalPath("myfans-research/phase6a/summary.json"), "myfans-research/phase6a/summary.json");
  for (const candidate of ["../secret", "a/../secret", "/absolute", "a\\b", "a//b", "./a", "a/"]) {
    assert.throws(() => validateLogicalPath(candidate), /STATE_PATH/);
  }
});

test("secret, cache, image, media and raw HTML paths are never uploadable", () => {
  assert.equal(statePathExclusionReason("evidence/cache/summary.json"), "CACHE_PATH");
  assert.equal(statePathExclusionReason("evidence/tmp/summary.json"), "CACHE_PATH");
  assert.equal(statePathExclusionReason("evidence/.env.local"), "SECRET_PATH");
  assert.equal(statePathExclusionReason("evidence/service-role.json"), "SECRET_PATH");
  assert.equal(statePathExclusionReason("evidence/sheet.png"), "IMAGE_OR_MEDIA");
  assert.equal(statePathExclusionReason("evidence/video.mp4"), "IMAGE_OR_MEDIA");
  assert.equal(statePathExclusionReason("evidence/sheet.pdf"), "IMAGE_OR_MEDIA");
  assert.equal(statePathExclusionReason("evidence/raw.html"), "RAW_HTML");
  assert.equal(statePathExclusionReason("evidence/summary.json"), null);
  assert.equal(statePathExclusionReason("evidence/manifest.jsonl.gz"), null);
  assert.throws(() => assertUploadableLogicalPath("evidence/credentials.json"), /SECRET_PATH/);
});

test("sha256 and state index serialization are deterministic and whitelist-only", () => {
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const entries = [
    {
      logical_path: "z/summary.json",
      sha256: "b".repeat(64),
      size: 2,
      updated_at: "2026-09-01T00:00:00Z",
      category: "ACTIVE_SUPPORTING",
      canonical: false,
      status: "active",
      source_phase: "phase-z",
      secret_value: "must-not-serialize",
    },
    {
      logical_path: "a/summary.json",
      sha256: "a".repeat(64),
      size: 1,
      updated_at: "2026-09-01T00:00:00Z",
      category: "ACTIVE_CANONICAL",
      canonical: true,
      status: "active",
      source_phase: "phase-a",
    },
  ];
  const forward = serializeStateIndex(entries);
  const reverse = serializeStateIndex([...entries].reverse());
  assert.equal(forward, reverse);
  assert.equal(forward.includes("must-not-serialize"), false);
  assert.deepEqual(parseStateIndex(forward).map((entry) => entry.logical_path), ["a/summary.json", "z/summary.json"]);
});

test("configured secret values are rejected without serializing the value", () => {
  const secret = "local-secret-value-12345";
  assert.throws(
    () => assertNoConfiguredSecretValues(Buffer.from(`prefix ${secret} suffix`), { SUPABASE_SERVICE_ROLE_KEY: secret }),
    (error) => error.message === "STATE_SECRET_VALUE_REJECTED:SUPABASE_SERVICE_ROLE_KEY" && !error.message.includes(secret),
  );
  assert.doesNotThrow(() => assertNoConfiguredSecretValues(Buffer.from("safe summary"), { SUPABASE_SERVICE_ROLE_KEY: secret }));
});

test("state client is pinned to the private Supabase bucket and project origin", () => {
  const client = createCloudStateClient({
    baseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role-test-value",
    fetchImpl: async () => {},
  });
  assert.equal(client.bucket, "okazudb-state-private");
  assert.throws(() => createCloudStateClient({
    baseUrl: "https://example.invalid",
    serviceRoleKey: "service-role-test-value",
    fetchImpl: async () => {},
  }), /ORIGIN_REJECTED/);
  assert.throws(() => createCloudStateClient({
    baseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role-test-value",
    bucket: "business-assets",
    fetchImpl: async () => {},
  }), /BUCKET_REJECTED/);
});

test("exact file inspection remains inside state root and hashes bytes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "okazu-cloud-state-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "phase", "summary.json");
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, "{\"safe\":true}\n");
  const result = await inspectExactStateFile({
    stateRoot: root,
    sourcePath: source,
    logicalPath: "phase/summary.json",
    metadata: {
      category: "ACTIVE_CANONICAL",
      canonical: true,
      status: "active",
      source_phase: "phase-test",
      updated_at: "2026-09-01T00:00:00Z",
    },
  });
  assert.equal(result.entry.size, result.bytes.length);
  assert.equal(result.entry.sha256, sha256(result.bytes));
  await assert.rejects(() => inspectExactStateFile({
    stateRoot: root,
    sourcePath: path.join(root, "..", "outside.json"),
    logicalPath: "phase/summary.json",
    metadata: {},
  }), /OUTSIDE_ROOT/);
});

test("atomic writer replaces a regular file and leaves no temporary file", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "okazu-cloud-atomic-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, "nested", "state.json");
  await atomicWriteFile(target, "first\n");
  await atomicWriteFile(target, "second\n");
  assert.equal(await fs.readFile(target, "utf8"), "second\n");
  assert.deepEqual(await fs.readdir(path.dirname(target)), ["state.json"]);
});

test("unknown cloud operations and free-form shell input are rejected", async () => {
  await assert.rejects(() => runCloudStateCli(["shell", "--command", "rm -rf x"]), /UNKNOWN_CLOUD_STATE_OPERATION/);
  await assert.rejects(() => runCloudStateCli(["sync", "--command", "echo unsafe"]), /OPTION_REJECTED/);
});
