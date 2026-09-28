import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const source = await readFile(path.resolve(testDir, "../src/download-delivery.js"), "utf8");
const sandbox = { TextEncoder, btoa };
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "download-delivery.js" });
const delivery = sandbox.MyFansDownloadDelivery;

function artifact(overrides = {}) {
  const serializedText = overrides.serialized_text || `${JSON.stringify({ title: "日本語😊", posts: [] }, null, 2)}\n`;
  return {
    filename: "myfans-affiliate-catalog-run-2026-09-25T05-40-32-742Z.json",
    serialized_text: serializedText,
    byte_length: new TextEncoder().encode(serializedText).byteLength,
    download_id: 41,
    ...overrides
  };
}

function decodeDataUrl(value) {
  const encoded = value.slice(delivery.DATA_URL_PREFIX.length);
  return Buffer.from(encoded, "base64");
}

test("download options preserve exact UTF-8 bytes and request collision-safe saving", () => {
  const value = artifact();
  const options = delivery.downloadOptions(value);
  assert.equal(options.filename, value.filename);
  assert.equal(options.saveAs, false);
  assert.equal(options.conflictAction, "uniquify");
  assert.deepEqual(decodeDataUrl(options.url), Buffer.from(value.serialized_text, "utf8"));
});

test("large Japanese, emoji, and long-title artifact survives data URL encoding", () => {
  const serializedText = `${JSON.stringify({
    title: `長文😊【確認】${"本文".repeat(180000)}`,
    posts: Array.from({ length: 199 }, (_, index) => ({ index, title: `作品${index}♡` }))
  }, null, 2)}\n`;
  const value = artifact({ serialized_text: serializedText });
  assert.ok(value.byte_length > 350000);
  assert.deepEqual(decodeDataUrl(delivery.artifactDataUrl(value)), Buffer.from(serializedText, "utf8"));
});

test("completed download accepts exact or uniquified filename and exact byte length", () => {
  const value = artifact();
  for (const filename of [
    `/Downloads/${value.filename}`,
    `/Downloads/${value.filename.replace(/\.json$/u, " (1).json")}`
  ]) {
    const validated = delivery.validateCompletedDownload({
        id: 41,
        state: "complete",
        filename,
        fileSize: value.byte_length,
        totalBytes: value.byte_length,
        exists: true
      }, value);
    assert.equal(validated.actual_resolved_filename, filename);
    assert.equal(validated.observed_byte_length, value.byte_length);
    assert.equal(validated.exists, true);
  }
});

test("completed download rejects missing files, mismatched names, and byte counts", () => {
  const value = artifact();
  const base = {
    id: 41,
    state: "complete",
    filename: `/Downloads/${value.filename}`,
    fileSize: value.byte_length,
    totalBytes: value.byte_length,
    exists: true
  };
  assert.throws(() => delivery.validateCompletedDownload({ ...base, exists: false }, value), /DOWNLOADED_FILE_NOT_PRESENT/);
  assert.throws(() => delivery.validateCompletedDownload({ ...base, filename: "/Downloads/wrong.json" }, value), /DOWNLOADED_FILENAME_MISMATCH/);
  assert.throws(() => delivery.validateCompletedDownload({ ...base, fileSize: value.byte_length - 1 }, value), /DOWNLOADED_BYTE_LENGTH_MISMATCH/);
});
