import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCodexCloudSetup } from "../scripts/cloud/setup-codex-cloud.mjs";

function outputBuffer() {
  let value = "";
  return {
    output: { write(chunk) { value += chunk; } },
    read() { return value; },
  };
}

test("Codex Cloud setup is idempotent and does not reinstall a warm cache", async (t) => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "okazu-cloud-setup-test-"));
  t.after(() => fs.rm(repoRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(repoRoot, "package-lock.json"), "{\"lockfileVersion\":3}\n");
  const stateRoot = path.join(repoRoot, "state");
  let installs = 0;
  const install = async () => {
    installs += 1;
    await fs.mkdir(path.join(repoRoot, "node_modules"), { recursive: true });
  };
  const firstOutput = outputBuffer();
  const first = await runCodexCloudSetup({
    env: { CODEX_CLOUD: "true", OKAZU_STATE_ROOT: stateRoot },
    repoRoot,
    nodeVersion: "22.23.1",
    install,
    output: firstOutput.output,
  });
  const secondOutput = outputBuffer();
  const second = await runCodexCloudSetup({
    env: { CODEX_CLOUD: "true", OKAZU_STATE_ROOT: stateRoot },
    repoRoot,
    nodeVersion: "22.23.1",
    install,
    output: secondOutput.output,
  });
  assert.equal(installs, 1);
  assert.equal(first.dependencies, "installed");
  assert.equal(second.dependencies, "cached");
  assert.equal(second.state_files_restored, 0);
});

test("setup checks Node 22, required env names and blocks production writes", async (t) => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "okazu-cloud-guard-test-"));
  t.after(() => fs.rm(repoRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(repoRoot, "package-lock.json"), "{}\n");
  const base = {
    repoRoot,
    install: async () => fs.mkdir(path.join(repoRoot, "node_modules"), { recursive: true }),
    output: outputBuffer().output,
  };
  await assert.rejects(() => runCodexCloudSetup({ ...base, env: {}, nodeVersion: "20.0.0" }), /NODE_MISMATCH/);
  await assert.rejects(() => runCodexCloudSetup({
    ...base,
    env: { OKAZU_PRODUCTION_WRITE_ENABLED: "true" },
    nodeVersion: "22.0.0",
  }), /PRODUCTION_WRITE_BLOCKED/);
  await assert.rejects(() => runCodexCloudSetup({
    ...base,
    env: { CODEX_CLOUD_REQUIRED_ENV_NAMES: "REQUIRED_ONE", OKAZU_STATE_ROOT: path.join(repoRoot, "state") },
    nodeVersion: "22.0.0",
  }), /REQUIRED_ENV_MISSING:REQUIRED_ONE/);
});

test("setup reports secret names but never values", async (t) => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "okazu-cloud-secret-test-"));
  t.after(() => fs.rm(repoRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(repoRoot, "package-lock.json"), "{}\n");
  const sink = outputBuffer();
  const secret = "service-role-value-must-not-appear";
  await runCodexCloudSetup({
    env: {
      CODEX_CLOUD_REQUIRED_ENV_NAMES: "SUPABASE_SERVICE_ROLE_KEY",
      OKAZU_STATE_ROOT: path.join(repoRoot, "state"),
      SUPABASE_SERVICE_ROLE_KEY: secret,
    },
    repoRoot,
    nodeVersion: "22.0.0",
    install: async () => fs.mkdir(path.join(repoRoot, "node_modules"), { recursive: true }),
    output: sink.output,
  });
  assert.match(sink.read(), /SUPABASE_SERVICE_ROLE_KEY/);
  assert.equal(sink.read().includes(secret), false);
  assert.match(sink.read(), /"production_write_enabled": false/);
});
