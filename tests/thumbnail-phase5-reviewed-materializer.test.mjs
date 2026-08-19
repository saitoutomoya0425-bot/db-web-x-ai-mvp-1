import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { materializePhase5ReviewedAssets } from "../scripts/materialize-thumbnail-phase5-reviewed-assets.mjs";

const DECISION_HEADER = "code,mode,source_id,source_path_or_url,source_hash,output_path_or_url,output_hash,approved_by,approved_at,approval_batch,reason,apply,review_status\n";
const EVIDENCE_HEADER = "product_code,video_id,external_product_id,mode,source_id,source_path_or_url,source_hash,output_path_or_url,output_hash,crop_left,crop_width,source_width,source_height,apply\n";
const URL = "https://pics.dmm.co.jp/digital/video/phase500001/phase500001pl.jpg";
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const response = (bytes) => ({ ok: true, status: 200, arrayBuffer: async () => bytes });

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "phase5-materializer-"));
  const source = await sharp({
    create: { width: 800, height: 538, channels: 3, background: { r: 80, g: 120, b: 160 } },
  }).jpeg({ quality: 95 }).toBuffer();
  const output = await sharp(source)
    .extract({ left: 405, top: 0, width: 395, height: 538 })
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer();
  return { directory, source, output };
}

function csv({ sourceHash, outputHash, code = "PHASE500001", outputPath = "/card-thumbnails/PHASE500001-auto-right.jpg" }) {
  const common = ["PACKAGE_RIGHT", "dvd:right", URL, sourceHash, outputPath, outputHash];
  return {
    decision: DECISION_HEADER + [
      code, ...common,
      "owner_delegated_via_chatgpt", "2026-08-19T06:43:13Z", "phase5f-canary-30",
      "delegated visual truth", "true", "HUMAN_APPROVED",
    ].join(",") + "\n",
    evidence: EVIDENCE_HEADER + [
      code, "video-phase5-1", "phase500001", ...common, "405", "395", "800", "538", "true",
    ].join(",") + "\n",
  };
}

async function writeInputs(directory, value) {
  const decisionFilePath = path.join(directory, "reviewed.csv");
  const evidenceFilePath = path.join(directory, "evidence.csv");
  await fs.writeFile(decisionFilePath, value.decision);
  await fs.writeFile(evidenceFilePath, value.evidence);
  return { decisionFilePath, evidenceFilePath };
}

test("materializer is deterministic and reuses an identical reviewed asset", async () => {
  const value = await fixture();
  const inputs = await writeInputs(
    value.directory,
    csv({ sourceHash: sha256(value.source), outputHash: sha256(value.output) }),
  );
  try {
    const first = await materializePhase5ReviewedAssets({
      ...inputs,
      repositoryRoot: value.directory,
      fetchImpl: async () => response(value.source),
      write: true,
    });
    const second = await materializePhase5ReviewedAssets({
      ...inputs,
      repositoryRoot: value.directory,
      fetchImpl: async () => response(value.source),
      write: true,
    });
    assert.equal(first.created_total, 1);
    assert.equal(second.reused_total, 1);
    const actual = await fs.readFile(path.join(value.directory, "public/card-thumbnails/PHASE500001-auto-right.jpg"));
    assert.equal(sha256(actual), sha256(value.output));
  } finally {
    await fs.rm(value.directory, { recursive: true, force: true });
  }
});
test("materializer fails closed on source and output hash mismatches", async () => {
  const value = await fixture();
  try {
    let inputs = await writeInputs(
      value.directory,
      csv({ sourceHash: "a".repeat(64), outputHash: sha256(value.output) }),
    );
    await assert.rejects(
      materializePhase5ReviewedAssets({ ...inputs, repositoryRoot: value.directory, fetchImpl: async () => response(value.source), write: true }),
      /SOURCE_HASH_MISMATCH/,
    );
    inputs = await writeInputs(
      value.directory,
      csv({ sourceHash: sha256(value.source), outputHash: "b".repeat(64) }),
    );
    await assert.rejects(
      materializePhase5ReviewedAssets({ ...inputs, repositoryRoot: value.directory, fetchImpl: async () => response(value.source), write: true }),
      /OUTPUT_HASH_MISMATCH/,
    );
  } finally {
    await fs.rm(value.directory, { recursive: true, force: true });
  }
});

test("materializer rejects path traversal before fetching", async () => {
  const value = await fixture();
  let fetched = false;
  const inputs = await writeInputs(value.directory, csv({
    code: "../ESCAPE",
    sourceHash: sha256(value.source),
    outputHash: sha256(value.output),
    outputPath: "/card-thumbnails/../ESCAPE-auto-right.jpg",
  }));
  try {
    await assert.rejects(
      materializePhase5ReviewedAssets({
        ...inputs,
        repositoryRoot: value.directory,
        fetchImpl: async () => { fetched = true; return response(value.source); },
        write: true,
      }),
      /OUTPUT_PATH_CONTRACT/,
    );
    assert.equal(fetched, false);
  } finally {
    await fs.rm(value.directory, { recursive: true, force: true });
  }
});

test("materializer never overwrites an existing differing file", async () => {
  const value = await fixture();
  const outputPath = path.join(value.directory, "public/card-thumbnails/PHASE500001-auto-right.jpg");
  const existing = Buffer.from("existing user bytes");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, existing);
  const inputs = await writeInputs(
    value.directory,
    csv({ sourceHash: sha256(value.source), outputHash: sha256(value.output) }),
  );
  try {
    await assert.rejects(
      materializePhase5ReviewedAssets({ ...inputs, repositoryRoot: value.directory, fetchImpl: async () => response(value.source), write: true }),
      /EXISTING_OUTPUT_DIFFERS/,
    );
    assert.deepEqual(await fs.readFile(outputPath), existing);
  } finally {
    await fs.rm(value.directory, { recursive: true, force: true });
  }
});
