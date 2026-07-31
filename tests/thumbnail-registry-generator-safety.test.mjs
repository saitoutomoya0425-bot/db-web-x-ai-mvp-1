import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import {
  buildCanonicalHumanMap,
  canonicalGoldSourceId,
  compareAscii,
  generateSource,
  writeFileAtomically,
  writeGeneratedRegistry,
} from "../scripts/generate-thumbnail-production-registry.mjs";
import {
  GENERATED_GOLD_DECISION_RECORDS,
  GENERATED_HUMAN_DECISION_RECORDS,
} from "../src/lib/thumbnail/generated-approved-decisions.ts";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generatorPath = path.join(
  root,
  "scripts",
  "generate-thumbnail-production-registry.mjs",
);
const generatedPath = path.join(
  root,
  "src",
  "lib",
  "thumbnail",
  "generated-approved-decisions.ts",
);
const sha256 = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

async function runGenerator(args = [], env = {}) {
  return execFileAsync(
    process.execPath,
    [
      "--no-warnings",
      "--experimental-strip-types",
      generatorPath,
      ...args,
    ],
    {
      cwd: root,
      env: { ...process.env, ...env },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
}

test("DSVR source adaptation is exact and Human maps use canonical keys", () => {
  assert.equal(
    canonicalGoldSourceId("DSVR00064", "sample:1_high_resolution"),
    "sample:1",
  );
  assert.equal(
    canonicalGoldSourceId("OTHER00001", "sample:1_high_resolution"),
    "sample:1_high_resolution",
  );
  assert.equal(
    canonicalGoldSourceId("DSVR00064", "sample:2_high_resolution"),
    "sample:2_high_resolution",
  );

  const canonicalized = buildCanonicalHumanMap([
    { code: "H_1784FT000062" },
    { code: "1NAMH500006" },
  ]);
  assert.equal(canonicalized.humanByCode.has("H_1784FTO00062"), true);
  assert.equal(canonicalized.humanByCode.has("H_1784FT000062"), false);
  assert.equal(canonicalized.humanByCode.has("1NAMH500006"), false);
  assert.equal(canonicalized.rejectedRows.length, 1);
});

test("ASCII ordering and generated output are locale independent", async () => {
  assert.equal(compareAscii("A", "B"), -1);
  assert.equal(compareAscii("B", "A"), 1);
  assert.equal(compareAscii("A", "A"), 0);

  const cLocale = await runGenerator([], { LC_ALL: "C", LANG: "C" });
  const repeatedCLocale = await runGenerator([], {
    LC_ALL: "C",
    LANG: "C",
  });
  const japaneseLocale = await runGenerator([], {
    LC_ALL: "ja_JP.UTF-8",
    LANG: "ja_JP.UTF-8",
  });
  assert.equal(cLocale.stdout, repeatedCLocale.stdout);
  assert.equal(cLocale.stderr, repeatedCLocale.stderr);
  assert.equal(sha256(cLocale.stdout), sha256(repeatedCLocale.stdout));
  assert.equal(cLocale.stdout, japaneseLocale.stdout);
  assert.equal(cLocale.stderr, japaneseLocale.stderr);
  assert.equal(sha256(cLocale.stdout), sha256(japaneseLocale.stdout));
});

test("atomic writer replaces only after a complete temporary write", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "thumbnail-registry-atomic-"),
  );
  try {
    const target = path.join(directory, "generated.ts");
    await fs.writeFile(target, "old\n", "utf8");
    await writeFileAtomically(target, "new\n");
    assert.equal(await fs.readFile(target, "utf8"), "new\n");

    const primaryError = new Error("PRIMARY_RENAME_FAILURE");
    let thrown = null;
    try {
      await writeFileAtomically(target, "must-not-replace\n", {
        filesystem: {
          open: fs.open,
          rename: async () => {
            throw primaryError;
          },
          unlink: fs.unlink,
        },
      });
    } catch (error) {
      thrown = error;
    }
    assert.equal(thrown, primaryError);
    assert.equal(await fs.readFile(target, "utf8"), "new\n");
    assert.deepEqual(
      (await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("primary error remains observable when temporary cleanup also fails", async () => {
  const primaryCases = [
    {
      label: "mutable Error",
      value: new Error("PRIMARY_RENAME_FAILURE"),
      keepsIdentity: true,
    },
    {
      label: "frozen Error",
      value: Object.freeze(new Error("FROZEN_PRIMARY_RENAME_FAILURE")),
      keepsIdentity: false,
    },
    {
      label: "sealed Error",
      value: Object.seal(new Error("SEALED_PRIMARY_RENAME_FAILURE")),
      keepsIdentity: false,
    },
    {
      label: "string",
      value: "STRING_PRIMARY_RENAME_FAILURE",
      keepsIdentity: false,
    },
  ];

  for (const primaryCase of primaryCases) {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "thumbnail-registry-dual-failure-"),
    );
    try {
      const target = path.join(directory, "generated.ts");
      await fs.writeFile(target, "stable\n", "utf8");
      const cleanupError = new Error("TEMP_UNLINK_FAILURE");
      let caught = false;
      let thrown;
      try {
        await writeFileAtomically(target, "must-not-replace\n", {
          filesystem: {
            open: fs.open,
            rename: async () => {
              throw primaryCase.value;
            },
            unlink: async () => {
              throw cleanupError;
            },
          },
        });
      } catch (error) {
        caught = true;
        thrown = error;
      }
      assert.equal(caught, true, primaryCase.label);
      if (primaryCase.keepsIdentity) {
        assert.equal(thrown, primaryCase.value);
        assert.equal(thrown.message, "PRIMARY_RENAME_FAILURE");
        assert.match(thrown.stack, /PRIMARY_RENAME_FAILURE/);
        assert.equal(thrown.cleanupError, cleanupError);
      } else {
        assert.ok(thrown instanceof AggregateError, primaryCase.label);
        assert.equal(thrown.errors[0], primaryCase.value, primaryCase.label);
        assert.equal(thrown.errors[1], cleanupError, primaryCase.label);
        assert.equal(Object.hasOwn(thrown, "cause"), true, primaryCase.label);
        assert.equal(thrown.cause, primaryCase.value, primaryCase.label);
      }
      assert.equal(await fs.readFile(target, "utf8"), "stable\n");

      const temporaryFiles = (await fs.readdir(directory)).filter((name) =>
        name.endsWith(".tmp")
      );
      assert.equal(temporaryFiles.length, 1, primaryCase.label);
      await fs.unlink(path.join(directory, temporaryFiles[0]));
      assert.equal(
        (await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")).length,
        0,
        primaryCase.label,
      );
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
});

test("falsy primary values are rethrown unchanged when cleanup succeeds", async () => {
  const primaryValues = [undefined, null, false, 0, "", Number.NaN];
  for (const primaryValue of primaryValues) {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "thumbnail-registry-falsy-primary-"),
    );
    try {
      const target = path.join(directory, "generated.ts");
      await fs.writeFile(target, "stable\n", "utf8");
      let caught = false;
      let thrown;
      try {
        await writeFileAtomically(target, "must-not-replace\n", {
          filesystem: {
            open: fs.open,
            rename: async () => {
              throw primaryValue;
            },
            unlink: fs.unlink,
          },
        });
      } catch (error) {
        caught = true;
        thrown = error;
      }
      assert.equal(caught, true, String(primaryValue));
      assert.equal(Object.is(thrown, primaryValue), true, String(primaryValue));
      assert.equal(await fs.readFile(target, "utf8"), "stable\n");
      assert.equal(
        (await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")).length,
        0,
        String(primaryValue),
      );
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
});

test("falsy primary values remain first cause when cleanup also fails", async () => {
  const primaryValues = [undefined, null, false, 0, "", Number.NaN];
  for (const primaryValue of primaryValues) {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "thumbnail-registry-falsy-dual-failure-"),
    );
    try {
      const target = path.join(directory, "generated.ts");
      await fs.writeFile(target, "stable\n", "utf8");
      const cleanupError = new Error("TEMP_UNLINK_FAILURE");
      let caught = false;
      let thrown;
      try {
        await writeFileAtomically(target, "must-not-replace\n", {
          filesystem: {
            open: fs.open,
            rename: async () => {
              throw primaryValue;
            },
            unlink: async () => {
              throw cleanupError;
            },
          },
        });
      } catch (error) {
        caught = true;
        thrown = error;
      }
      assert.equal(caught, true, String(primaryValue));
      assert.ok(thrown instanceof AggregateError, String(primaryValue));
      assert.equal(Object.is(thrown.errors[0], primaryValue), true);
      assert.equal(thrown.errors[1], cleanupError);
      assert.equal(Object.hasOwn(thrown, "cause"), true);
      assert.equal(Object.is(thrown.cause, primaryValue), true);
      assert.equal(await fs.readFile(target, "utf8"), "stable\n");

      const temporaryFiles = (await fs.readdir(directory)).filter((name) =>
        name.endsWith(".tmp")
      );
      assert.equal(temporaryFiles.length, 1, String(primaryValue));
      await fs.unlink(path.join(directory, temporaryFiles[0]));
      assert.equal(
        (await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")).length,
        0,
        String(primaryValue),
      );
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
});

test("cleanup-only failure is reported when the primary write succeeds", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "thumbnail-registry-cleanup-failure-"),
  );
  try {
    const target = path.join(directory, "generated.ts");
    await fs.writeFile(target, "old\n", "utf8");
    const cleanupError = new Error("TEMP_UNLINK_FAILURE");
    let thrown = null;
    try {
      await writeFileAtomically(target, "new\n", {
        filesystem: {
          open: fs.open,
          rename: fs.rename,
          unlink: async () => {
            throw cleanupError;
          },
        },
      });
    } catch (error) {
      thrown = error;
    }
    assert.equal(thrown, cleanupError);
    assert.equal(await fs.readFile(target, "utf8"), "new\n");
    assert.equal(
      (await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")).length,
      0,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("canonical Human alias collision fails before replacing the target", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "thumbnail-registry-collision-"),
  );
  try {
    const dataDirectory = path.join(directory, "data");
    const publicDirectory = path.join(directory, "public");
    await fs.mkdir(dataDirectory);
    await fs.mkdir(publicDirectory);
    const goldFilePath = path.join(dataDirectory, "gold.csv");
    const humanFilePath = path.join(dataDirectory, "human.csv");
    const overridesFilePath = path.join(dataDirectory, "overrides.json");
    const targetPath = path.join(directory, "generated.ts");
    await fs.writeFile(
      goldFilePath,
      "product_code,expected_type,expected_source,decision_status,decision_basis,notes\n",
    );
    await fs.writeFile(
      humanFilePath,
      [
        "code,decision,accepted_mode,accepted_source_id,accepted_image_path,accepted_image_hash,approved_at,note,approval_pattern_id",
        "H_1784FT000062,CURRENT_OK,,,,,,,",
        "H_1784FTO00062,CURRENT_OK,,,,,,,",
        "",
      ].join("\n"),
    );
    await fs.writeFile(overridesFilePath, "{}\n");
    await fs.writeFile(targetPath, "stable\n");

    await assert.rejects(
      writeGeneratedRegistry({
        targetPath,
        generatorOptions: {
          goldFilePath,
          humanFilePath,
          overridesFilePath,
          publicDirectory,
          fixedDecisions: new Map(),
        },
      }),
      /HUMAN_APPROVAL_CANONICAL_COLLISION:H_1784FTO00062:H_1784FT000062:H_1784FTO00062/,
    );
    assert.equal(await fs.readFile(targetPath, "utf8"), "stable\n");
    assert.deepEqual(
      (await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("local approved symlink is rejected instead of skipped", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "thumbnail-registry-symlink-"),
  );
  try {
    const dataDirectory = path.join(directory, "data");
    const publicDirectory = path.join(directory, "public");
    await fs.mkdir(dataDirectory);
    await fs.mkdir(publicDirectory);
    const source = path.join(directory, "source.jpg");
    await fs.writeFile(source, "approved-image");
    await fs.symlink(
      source,
      path.join(publicDirectory, "TEST00001-gold-sample-1.jpg"),
    );
    const goldFilePath = path.join(dataDirectory, "gold.csv");
    const humanFilePath = path.join(dataDirectory, "human.csv");
    const overridesFilePath = path.join(dataDirectory, "overrides.json");
    await fs.writeFile(
      goldFilePath,
      [
        "product_code,expected_type,expected_source,decision_status,decision_basis,notes",
        "TEST00001,sample,sample:1,confirmed,test,symlink",
        "",
      ].join("\n"),
    );
    await fs.writeFile(
      humanFilePath,
      "code,decision,accepted_mode,accepted_source_id,accepted_image_path,accepted_image_hash,approved_at,note,approval_pattern_id\n",
    );
    await fs.writeFile(overridesFilePath, "{}\n");

    await assert.rejects(
      generateSource({
        goldFilePath,
        humanFilePath,
        overridesFilePath,
        publicDirectory,
        fixedDecisions: new Map(),
      }),
      /GOLD_CONVENTION:TEST00001:SYMLINK_APPROVED_OUTPUT/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("--check does not change registry content, metadata, or directory entries", async () => {
  const beforeContent = await fs.readFile(generatedPath);
  const beforeHash = crypto.createHash("sha256").update(beforeContent).digest("hex");
  const beforeStat = await fs.stat(generatedPath, { bigint: true });
  const beforeEntries = await fs.readdir(path.dirname(generatedPath));
  const beforeTemporaryEntries = beforeEntries.filter((name) =>
    name.startsWith(`.${path.basename(generatedPath)}.`) && name.endsWith(".tmp")
  );
  assert.equal(beforeTemporaryEntries.length, 0);

  await runGenerator(["--check"]);

  const afterContent = await fs.readFile(generatedPath);
  const afterHash = crypto.createHash("sha256").update(afterContent).digest("hex");
  const afterStat = await fs.stat(generatedPath, { bigint: true });
  const afterEntries = await fs.readdir(path.dirname(generatedPath));
  const afterTemporaryEntries = afterEntries.filter((name) =>
    name.startsWith(`.${path.basename(generatedPath)}.`) && name.endsWith(".tmp")
  );
  assert.equal(afterHash, beforeHash);
  assert.deepEqual(afterContent, beforeContent);
  assert.equal(afterStat.ino, beforeStat.ino);
  assert.equal(afterStat.mode, beforeStat.mode);
  assert.equal(afterStat.size, beforeStat.size);
  assert.equal(afterStat.mtimeNs, beforeStat.mtimeNs);
  assert.equal(afterStat.ctimeNs, beforeStat.ctimeNs);
  assert.equal(afterTemporaryEntries.length, 0);
  assert.deepEqual(afterTemporaryEntries, beforeTemporaryEntries);
  assert.deepEqual(afterEntries, beforeEntries);
});

test("CSV row order changes only raw provenance, not normalized decisions", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "thumbnail-registry-row-order-"),
  );
  try {
    const dataDirectory = path.join(directory, "data");
    const publicDirectory = path.join(directory, "public");
    await fs.mkdir(dataDirectory);
    await fs.mkdir(publicDirectory);
    await fs.writeFile(
      path.join(publicDirectory, "AAA00001-gold-sample-1.jpg"),
      "image-a",
    );
    await fs.writeFile(
      path.join(publicDirectory, "BBB00002-gold-sample-1.jpg"),
      "image-b",
    );
    const goldFilePath = path.join(dataDirectory, "gold.csv");
    const humanFilePath = path.join(dataDirectory, "human.csv");
    const overridesFilePath = path.join(dataDirectory, "overrides.json");
    const header =
      "product_code,expected_type,expected_source,decision_status,decision_basis,notes\n";
    const rowA = "AAA00001,sample,sample:1,confirmed,test,a\n";
    const rowB = "BBB00002,sample,sample:1,confirmed,test,b\n";
    await fs.writeFile(
      humanFilePath,
      "code,decision,accepted_mode,accepted_source_id,accepted_image_path,accepted_image_hash,approved_at,note,approval_pattern_id\n",
    );
    await fs.writeFile(overridesFilePath, "{}\n");
    const options = {
      goldFilePath,
      humanFilePath,
      overridesFilePath,
      publicDirectory,
      fixedDecisions: new Map(),
    };

    await fs.writeFile(goldFilePath, `${header}${rowA}${rowB}`);
    const first = await generateSource(options);
    await fs.writeFile(goldFilePath, `${header}${rowB}${rowA}`);
    const second = await generateSource(options);

    assert.notEqual(
      first.rawInputByteDigests.gold_sha256,
      second.rawInputByteDigests.gold_sha256,
    );
    assert.notEqual(sha256(first.source), sha256(second.source));
    assert.deepEqual(first.goldRecords, second.goldRecords);
    assert.deepEqual(first.humanRecords, second.humanRecords);
    assert.deepEqual(first.stats, second.stats);
    assert.deepEqual(
      first.goldRecords.map((record) => record.code),
      ["AAA00001", "BBB00002"],
    );
    const removeRawGoldDigest = (source) =>
      source.replace(
        /"gold_sha256": "[a-f0-9]{64}"/,
        '"gold_sha256": "<raw-byte-provenance>"',
      );
    assert.equal(
      removeRawGoldDigest(first.source),
      removeRawGoldDigest(second.source),
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("all 32 generated local READY assets are regular, in-tree, nonempty, and hash-matched", async () => {
  assert.equal(GENERATED_HUMAN_DECISION_RECORDS.length, 0);
  const localRecords = GENERATED_GOLD_DECISION_RECORDS.filter(
    (record) =>
      record.state === "RESOLVED" &&
      record.output_path_or_url.startsWith("/card-thumbnails/"),
  );
  const externalRecords = GENERATED_GOLD_DECISION_RECORDS.filter(
    (record) =>
      record.state === "RESOLVED" &&
      record.output_path_or_url.startsWith("https://pics.dmm.co.jp/"),
  );
  assert.equal(localRecords.length, 32);
  assert.equal(externalRecords.length, 14);

  const publicDirectory = path.join(root, "public", "card-thumbnails");
  const realPublicDirectory = await fs.realpath(publicDirectory);
  for (const record of localRecords) {
    const relative = record.output_path_or_url.slice("/card-thumbnails/".length);
    const file = path.join(publicDirectory, relative);
    const info = await fs.lstat(file);
    assert.equal(info.isSymbolicLink(), false, record.code);
    assert.equal(info.isFile(), true, record.code);
    assert.ok(info.size > 0, record.code);
    const realFile = await fs.realpath(file);
    assert.ok(
      realFile.startsWith(`${realPublicDirectory}${path.sep}`),
      record.code,
    );
    const hash = crypto
      .createHash("sha256")
      .update(await fs.readFile(file))
      .digest("hex");
    assert.equal(hash, record.output_hash, record.code);
  }
});
