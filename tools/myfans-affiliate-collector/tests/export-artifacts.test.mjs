import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const source = await readFile(path.resolve(testDir, "../src/export-artifacts.js"), "utf8");
const sandbox = { crypto: webcrypto, TextEncoder };
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "export-artifacts.js" });
const artifacts = sandbox.MyFansExportArtifacts;
const generatedAt = "2026-09-26T01:02:03.456Z";

async function artifactFor(value, type = "RUN") {
  return artifacts.serializeExportArtifact(value, { artifact_type: type, generated_at: generatedAt });
}

test("different object insertion order produces identical canonical bytes and hashes", async () => {
  const left = { collected_at: generatedAt, z: 1, a: 2 };
  const right = { a: 2, z: 1, collected_at: generatedAt };
  const leftArtifact = await artifactFor(left);
  const rightArtifact = await artifactFor(right);
  assert.equal(leftArtifact.serialized_text, rightArtifact.serialized_text);
  assert.equal(leftArtifact.content_hash, rightArtifact.content_hash);
});

test("nested object keys are canonical while array order remains meaningful", async () => {
  const left = { collected_at: generatedAt, nested: { z: 1, a: 2 }, values: ["first", "second"] };
  const right = { values: ["first", "second"], nested: { a: 2, z: 1 }, collected_at: generatedAt };
  const reversed = { ...right, values: ["second", "first"] };
  assert.equal((await artifactFor(left)).serialized_text, (await artifactFor(right)).serialized_text);
  assert.notEqual((await artifactFor(left)).serialized_text, (await artifactFor(reversed)).serialized_text);
});

test("Japanese, emoji, brackets, symbols, null, and numbers round-trip unchanged", async () => {
  const value = {
    collected_at: generatedAt,
    title: "某所で大バズり😊【期間限定】¥4,980…♡",
    nullable: null,
    count: 199,
    rate: 50.5
  };
  const artifact = await artifactFor(value);
  assert.deepEqual(JSON.parse(artifact.serialized_text), value);
  assert.equal(await artifacts.verifyExportArtifact(artifact), true);
});

test("long titles remain lossless", async () => {
  const title = `長文😊${"本文".repeat(3000)}`;
  const artifact = await artifactFor({ collected_at: generatedAt, title });
  assert.equal(JSON.parse(artifact.serialized_text).title, title);
  assert.equal(await artifacts.verifyExportArtifact(artifact), true);
});

test("canonical text is pretty JSON with exactly one trailing newline", async () => {
  const artifact = await artifactFor({ collected_at: generatedAt, nested: { value: 1 } });
  assert.match(artifact.serialized_text, /\n  "collected_at":/u);
  assert.equal(artifact.serialized_text.endsWith("\n"), true);
  assert.equal(artifact.serialized_text.endsWith("\n\n"), false);
});

test("byte length and SHA-256 cover the exact UTF-8 download text", async () => {
  const artifact = await artifactFor({ collected_at: generatedAt, title: "日本語😊" });
  const downloadBytes = new TextEncoder().encode(artifact.serialized_text);
  assert.equal(artifact.byte_length, downloadBytes.byteLength);
  assert.equal(artifact.content_hash, await artifacts.sha256Utf8(artifact.serialized_text));
  assert.equal(await artifacts.verifyExportArtifact(artifact), true);
});

test("storage JSON round-trip leaves the lossless serialized text unchanged", async () => {
  const generated = await artifactFor({ collected_at: generatedAt, z: "終", a: "始" });
  const restored = JSON.parse(JSON.stringify(generated));
  assert.equal(restored.serialized_text, generated.serialized_text);
  assert.equal(restored.content_hash, generated.content_hash);
  assert.equal(await artifacts.verifyExportArtifact(restored), true);
});

test("structured-clone round-trip leaves artifact bytes and hash unchanged", async () => {
  const generated = await artifactFor({ collected_at: generatedAt, title: "clone😊" }, "CUMULATIVE");
  const restored = structuredClone(generated);
  assert.equal(restored.serialized_text, generated.serialized_text);
  assert.equal(restored.content_hash, generated.content_hash);
  assert.equal(await artifacts.verifyExportArtifact(restored), true);
});

test("tampered text and byte length fail verification", async () => {
  const generated = await artifactFor({ collected_at: generatedAt, title: "original" });
  await assert.rejects(
    artifacts.verifyExportArtifact({ ...generated, serialized_text: generated.serialized_text.replace("original", "tampered") }),
    /EXPORT_ARTIFACT_HASH_MISMATCH/
  );
  await assert.rejects(
    artifacts.verifyExportArtifact({ ...generated, byte_length: generated.byte_length + 1 }),
    /EXPORT_ARTIFACT_BYTE_LENGTH_MISMATCH/
  );
  await assert.rejects(
    artifacts.verifyExportArtifact({ ...generated, filename: "changed.json" }),
    /EXPORT_ARTIFACT_FILENAME_MISMATCH/
  );
});

test("run and cumulative filenames use stable source timestamps", async () => {
  const value = { collected_at: generatedAt, posts: [] };
  const run = await artifactFor(value, "RUN");
  const cumulative = await artifactFor(value, "CUMULATIVE");
  assert.equal(run.filename, "myfans-affiliate-catalog-run-2026-09-26T01-02-03-456Z.json");
  assert.equal(cumulative.filename, "myfans-affiliate-catalog-cumulative-2026-09-26T01-02-03-456Z.json");
  assert.equal((await artifactFor(value, "RUN")).filename, run.filename);
});
