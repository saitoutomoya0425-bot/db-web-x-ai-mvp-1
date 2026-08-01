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
  parseCsv,
  readJpegDimensions,
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
const EMPTY_SCENE_CROP_HEADER =
  "code,mode,source_id,source_kind,source_path_or_url,source_local_path,output_path_or_url,object_fit,crop_spec,crop_variant,approval_status,render_status,approved_by,approved_at,source_hash,output_hash,reason\n";
const SCENE_SOURCE_JPEG = await fs.readFile(
  path.join(
    root,
    "data/thumbnail-scene-crop-sources/1SBP00395-scene-pl-fbfcc07df212471c.jpg",
  ),
);
const SCENE_OUTPUT_JPEG = await fs.readFile(
  path.join(root, "public/card-thumbnails/1SBP00395-scene-portrait-v4.jpg"),
);
const ROTATED_SCENE_SOURCE_JPEG = await fs.readFile(
  path.join(
    root,
    "data/thumbnail-scene-crop-sources/1SBP00424-scene-pl-644bf16443157666.jpg",
  ),
);
const ROTATED_SCENE_OUTPUT_JPEG = await fs.readFile(
  path.join(root, "public/card-thumbnails/1SBP00424-scene-portrait-v4.jpg"),
);
const csvCell = (value) => `"${String(value).replaceAll('"', '""')}"`;
const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

function jpegSegment(marker, payload, declaredLength = payload.length + 2) {
  return Buffer.concat([
    Buffer.from([0xff, marker, declaredLength >> 8, declaredLength & 0xff]),
    Buffer.from(payload),
  ]);
}

function jpegSof({
  marker = 0xc0,
  width = 800,
  height = 450,
  componentIds = [1],
  declaredComponentCount = componentIds.length,
  declaredLength,
} = {}) {
  const payload = [
    8,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    declaredComponentCount,
  ];
  for (const componentId of componentIds) {
    payload.push(componentId, 0x11, 0);
  }
  return jpegSegment(marker, payload, declaredLength);
}

function jpegSos({
  componentIds = [1],
  declaredComponentCount = componentIds.length,
  declaredLength,
} = {}) {
  const payload = [declaredComponentCount];
  for (const componentId of componentIds) payload.push(componentId, 0);
  payload.push(0, 63, 0);
  return jpegSegment(0xda, payload, declaredLength);
}

function minimalJpeg({
  width = 800,
  height = 450,
  sofMarker = 0xc0,
  entropy = [0x11],
  includeEoi = true,
} = {}) {
  return Buffer.concat([
    JPEG_SOI,
    jpegSof({ marker: sofMarker, width, height }),
    jpegSos(),
    Buffer.from(entropy),
    ...(includeEoi ? [JPEG_EOI] : []),
  ]);
}

async function createSceneCropFixture({
  code = "TEST00001",
  crop = { unit: "pixel", x: 0, y: 0, width: 315, height: 450 },
  cropVariant = "STANDARD",
  sourceBytes = SCENE_SOURCE_JPEG,
  sourceHash = sha256(sourceBytes),
  sourceScenario = "file",
  outputBytes = SCENE_OUTPUT_JPEG,
} = {}) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), `thumbnail-scene-crop-${sourceScenario}-`),
  );
  const outsideDirectory =
    sourceScenario === "root-escape"
      ? await fs.mkdtemp(path.join(os.tmpdir(), "thumbnail-scene-crop-outside-"))
      : null;
  const dataDirectory = path.join(directory, "data");
  const publicDirectory = path.join(directory, "public");
  const sourceDirectory = path.join(
    directory,
    "data",
    "thumbnail-scene-crop-sources",
  );
  const sourceRelativePath = `data/thumbnail-scene-crop-sources/${code}-scene-pl-${sourceHash.slice(0, 16)}.jpg`;
  const sourcePath = path.join(directory, sourceRelativePath);
  const outputPath = path.join(publicDirectory, `${code}-scene-portrait-v4.jpg`);
  const outputHash = sha256(outputBytes);
  const sourceUrl = `https://pics.dmm.co.jp/digital/video/${code.toLowerCase()}/${code.toLowerCase()}pl.jpg`;

  await fs.mkdir(dataDirectory, { recursive: true });
  await fs.mkdir(publicDirectory, { recursive: true });
  await fs.writeFile(outputPath, outputBytes);
  if (sourceScenario === "root-escape") {
    await fs.writeFile(path.join(outsideDirectory, path.basename(sourcePath)), sourceBytes);
    await fs.symlink(outsideDirectory, sourceDirectory);
  } else {
    await fs.mkdir(sourceDirectory, { recursive: true });
    if (sourceScenario === "empty") {
      await fs.writeFile(sourcePath, Buffer.alloc(0));
    } else if (sourceScenario === "symlink") {
      const realSource = path.join(directory, "real-source.jpg");
      await fs.writeFile(realSource, sourceBytes);
      await fs.symlink(realSource, sourcePath);
    } else if (sourceScenario !== "missing") {
      await fs.writeFile(sourcePath, sourceBytes);
    }
  }

  const goldFilePath = path.join(dataDirectory, "gold.csv");
  const humanFilePath = path.join(dataDirectory, "human.csv");
  const overridesFilePath = path.join(dataDirectory, "overrides.json");
  const sceneCropFilePath = path.join(dataDirectory, "scene-crop.csv");
  await fs.writeFile(
    goldFilePath,
    "product_code,expected_type,expected_source,decision_status,decision_basis,notes\n",
  );
  const acceptedSourceId =
    cropVariant === "REVISED"
      ? "scene_portrait:revised"
      : cropVariant === "ROTATE_CLOCKWISE_B"
        ? "scene_portrait:rotate_clockwise_b"
        : "scene_portrait";
  await fs.writeFile(
    humanFilePath,
    [
      "code,decision,accepted_mode,accepted_source_id,accepted_image_path,accepted_image_hash,approved_at,note,approval_pattern_id",
      `${code},CURRENT_OK,scene_portrait,${acceptedSourceId},public/card-thumbnails/${code}-scene-portrait-v4.jpg,${outputHash},2026-07-28,approved,`,
      "",
    ].join("\n"),
  );
  await fs.writeFile(overridesFilePath, "{}\n");
  const sceneRow = [
    code,
    "SCENE_CROP",
    "scene:pl",
    "SCENE",
    sourceUrl,
    sourceRelativePath,
    `/card-thumbnails/${code}-scene-portrait-v4.jpg`,
    "cover",
    JSON.stringify(crop),
    cropVariant,
    "HUMAN_APPROVED",
    "READY",
    "USER_HANDOFF",
    "2026-07-28",
    sourceHash,
    outputHash,
    "approved scene crop",
  ].map(csvCell).join(",");
  await fs.writeFile(sceneCropFilePath, `${EMPTY_SCENE_CROP_HEADER}${sceneRow}\n`);

  return {
    directory,
    outsideDirectory,
    options: {
      goldFilePath,
      humanFilePath,
      overridesFilePath,
      sceneCropFilePath,
      publicDirectory,
      repositoryDirectory: directory,
      expectedSceneCropCount: 1,
      fixedDecisions: new Map(),
    },
    cleanup: async () => {
      await fs.rm(directory, { recursive: true, force: true });
      if (outsideDirectory) {
        await fs.rm(outsideDirectory, { recursive: true, force: true });
      }
    },
  };
}

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
    const sceneCropFilePath = path.join(dataDirectory, "scene-crop.csv");
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
    await fs.writeFile(sceneCropFilePath, EMPTY_SCENE_CROP_HEADER);
    await fs.writeFile(targetPath, "stable\n");

    await assert.rejects(
      writeGeneratedRegistry({
        targetPath,
        generatorOptions: {
          goldFilePath,
          humanFilePath,
          overridesFilePath,
          sceneCropFilePath,
          publicDirectory,
          repositoryDirectory: directory,
          expectedSceneCropCount: 0,
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
    const sceneCropFilePath = path.join(dataDirectory, "scene-crop.csv");
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
    await fs.writeFile(sceneCropFilePath, EMPTY_SCENE_CROP_HEADER);

    await assert.rejects(
      generateSource({
        goldFilePath,
        humanFilePath,
        overridesFilePath,
        sceneCropFilePath,
        publicDirectory,
        repositoryDirectory: directory,
        expectedSceneCropCount: 0,
        fixedDecisions: new Map(),
      }),
      /GOLD_CONVENTION:TEST00001:SYMLINK_APPROVED_OUTPUT/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("scene-crop source provenance fails closed", async (t) => {
  const cases = [
    ["missing", "SCENE_CROP:TEST00001:MISSING_LOCAL_SOURCE"],
    ["empty", "SCENE_CROP:TEST00001:EMPTY_LOCAL_SOURCE"],
    ["symlink", "SCENE_CROP:TEST00001:SYMLINK_LOCAL_SOURCE"],
    ["root-escape", "SCENE_CROP:TEST00001:LOCAL_SOURCE_REALPATH_ESCAPE"],
    ["hash-mismatch", "SCENE_CROP:TEST00001:LOCAL_SOURCE_HASH_MISMATCH"],
    ["broken-jpeg", "SCENE_CROP:TEST00001:INVALID_JPEG"],
  ];

  for (const [scenario, expectedError] of cases) {
    await t.test(scenario, async () => {
      const sourceBytes =
        scenario === "broken-jpeg" ? Buffer.from("not-a-jpeg") : SCENE_SOURCE_JPEG;
      const fixture = await createSceneCropFixture({
        sourceBytes,
        sourceHash:
          scenario === "hash-mismatch" ? "f".repeat(64) : sha256(sourceBytes),
        sourceScenario:
          scenario === "hash-mismatch" || scenario === "broken-jpeg"
            ? "file"
            : scenario,
      });
      try {
        await assert.rejects(
          generateSource(fixture.options),
          new RegExp(expectedError),
        );
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

test("production JPEG parser rejects malformed structure and unsafe dimensions", async (t) => {
  const validSof = jpegSof();
  const validSos = jpegSos();
  const cases = [
    [
      "sof-eoi-without-sos-or-scan",
      Buffer.concat([JPEG_SOI, validSof, JPEG_EOI]),
      "JPEG_SCAN_MISSING",
    ],
    [
      "sos-eoi-without-entropy",
      Buffer.concat([JPEG_SOI, validSof, validSos, JPEG_EOI]),
      "EMPTY_JPEG_SCAN",
    ],
    [
      "forged-65535-square",
      minimalJpeg({ width: 65_535, height: 65_535 }),
      "JPEG_DIMENSIONS_LIMIT_EXCEEDED",
    ],
    [
      "dimension-limit",
      minimalJpeg({ width: 16_385, height: 1 }),
      "JPEG_DIMENSIONS_LIMIT_EXCEEDED",
    ],
    [
      "pixel-limit",
      minimalJpeg({ width: 10_001, height: 10_000 }),
      "JPEG_DIMENSIONS_LIMIT_EXCEEDED",
    ],
    [
      "sos-before-sof",
      Buffer.concat([JPEG_SOI, validSos, Buffer.from([0x11]), JPEG_EOI]),
      "JPEG_SOS_BEFORE_SOF",
    ],
    ["eoi-missing", minimalJpeg({ includeEoi: false }), "TRUNCATED_JPEG"],
    [
      "sos-missing",
      Buffer.concat([JPEG_SOI, validSof, jpegSegment(0xe0, []), JPEG_EOI]),
      "JPEG_SCAN_MISSING",
    ],
    ["sof-missing", Buffer.concat([JPEG_SOI, JPEG_EOI]), "JPEG_DIMENSIONS_MISSING"],
    [
      "sof-component-length-mismatch",
      Buffer.concat([
        JPEG_SOI,
        jpegSof({ componentIds: [1], declaredComponentCount: 2 }),
        JPEG_EOI,
      ]),
      "INVALID_JPEG_SOF",
    ],
    [
      "sos-component-length-mismatch",
      Buffer.concat([
        JPEG_SOI,
        validSof,
        jpegSos({ componentIds: [1], declaredComponentCount: 2 }),
        JPEG_EOI,
      ]),
      "INVALID_JPEG_SOS",
    ],
    [
      "restart-marker-only",
      Buffer.concat([
        JPEG_SOI,
        validSof,
        validSos,
        Buffer.from([0xff, 0xd0]),
        JPEG_EOI,
      ]),
      "EMPTY_JPEG_SCAN",
    ],
    [
      "fill-byte-only",
      Buffer.concat([
        JPEG_SOI,
        validSof,
        validSos,
        Buffer.from([0xff, 0xff]),
        JPEG_EOI,
      ]),
      "EMPTY_JPEG_SCAN",
    ],
    [
      "truncated-entropy-marker",
      Buffer.concat([
        JPEG_SOI,
        validSof,
        validSos,
        Buffer.from([0x11, 0xff]),
      ]),
      "TRUNCATED_JPEG",
    ],
    [
      "segment-length-zero",
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00]),
      "INVALID_JPEG",
    ],
    [
      "segment-length-one",
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01]),
      "INVALID_JPEG",
    ],
    [
      "segment-outside-buffer",
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x00]),
      "INVALID_JPEG",
    ],
    ["zero-width", minimalJpeg({ width: 0 }), "INVALID_JPEG_DIMENSIONS"],
    ["zero-height", minimalJpeg({ height: 0 }), "INVALID_JPEG_DIMENSIONS"],
    [
      "duplicate-sof",
      Buffer.concat([
        JPEG_SOI,
        validSof,
        validSof,
        validSos,
        Buffer.from([0x11]),
        JPEG_EOI,
      ]),
      "DUPLICATE_JPEG_SOF",
    ],
    [
      "conflicting-sof",
      Buffer.concat([
        JPEG_SOI,
        validSof,
        jpegSof({ width: 801 }),
        validSos,
        Buffer.from([0x11]),
        JPEG_EOI,
      ]),
      "DUPLICATE_JPEG_SOF",
    ],
    [
      "invalid-marker",
      Buffer.from([0xff, 0xd8, 0xff, 0x02, 0x00, 0x02, 0xff, 0xd9]),
      "INVALID_JPEG_MARKER",
    ],
  ];

  for (const [label, bytes, expectedError] of cases) {
    await t.test(label, () => {
      assert.throws(
        () => readJpegDimensions(bytes, `JPEG_FIXTURE:${label}`),
        new RegExp(expectedError),
      );
    });
  }
});

test("production JPEG parser accepts scan data, stuffing, restart, fill, and progressive SOF", async (t) => {
  const cases = [
    ["minimal", minimalJpeg()],
    ["byte-stuffing", minimalJpeg({ entropy: [0xff, 0x00] })],
    [
      "restart-marker-with-entropy",
      minimalJpeg({ entropy: [0x11, 0xff, 0xd0, 0x22] }),
    ],
    ["fill-byte-after-entropy", minimalJpeg({ entropy: [0x11, 0xff, 0xff] })],
    ["progressive-sof", minimalJpeg({ sofMarker: 0xc2 })],
  ];

  for (const [label, bytes] of cases) {
    await t.test(label, () => {
      assert.deepEqual(
        readJpegDimensions(bytes, `JPEG_FIXTURE:${label}`),
        { width: 800, height: 450 },
      );
    });
  }
});

test("production JPEG parser validates all 29 approved sources and outputs", async () => {
  const rows = parseCsv(
    await fs.readFile(
      path.join(root, "data", "thumbnail-scene-crop-allowlist.csv"),
      "utf8",
    ),
  );
  assert.equal(rows.length, 29);

  let validatedFiles = 0;
  for (const row of rows) {
    const sourceBytes = await fs.readFile(path.join(root, row.source_local_path));
    assert.equal(sha256(sourceBytes), row.source_hash, `${row.code}:source-hash`);
    assert.deepEqual(
      readJpegDimensions(sourceBytes, `${row.code}:source`),
      { width: 800, height: 450 },
      `${row.code}:source-dimensions`,
    );
    validatedFiles += 1;

    const outputRelativePath = row.output_path_or_url.replace(
      /^\/card-thumbnails\//,
      "public/card-thumbnails/",
    );
    const outputBytes = await fs.readFile(path.join(root, outputRelativePath));
    assert.equal(sha256(outputBytes), row.output_hash, `${row.code}:output-hash`);
    assert.deepEqual(
      readJpegDimensions(outputBytes, `${row.code}:output`),
      { width: 315, height: 450 },
      `${row.code}:output-dimensions`,
    );
    validatedFiles += 1;
  }
  assert.equal(validatedFiles, 58);
});

test("scene-crop coordinates are safe integers and remain inside post-rotation bounds", async (t) => {
  const cases = [
    ["negative", { unit: "pixel", x: -1, y: 0, width: 315, height: 450 }, "STANDARD", "TEST00001", "INVALID_CROP_SPEC"],
    ["negative-y", { unit: "pixel", x: 0, y: -1, width: 315, height: 450 }, "STANDARD", "TEST00001", "INVALID_CROP_SPEC"],
    ["zero-width", { unit: "pixel", x: 0, y: 0, width: 0, height: 450 }, "STANDARD", "TEST00001", "INVALID_CROP_SPEC"],
    ["zero-height", { unit: "pixel", x: 0, y: 0, width: 315, height: 0 }, "STANDARD", "TEST00001", "INVALID_CROP_SPEC"],
    ["unsafe-integer", { unit: "pixel", x: Number.MAX_SAFE_INTEGER + 1, y: 0, width: 1, height: 1 }, "STANDARD", "TEST00001", "INVALID_CROP_SPEC"],
    ["x-overflow", { unit: "pixel", x: 500, y: 0, width: 315, height: 450 }, "STANDARD", "TEST00001", "CROP_OUT_OF_BOUNDS"],
    ["y-overflow", { unit: "pixel", x: 0, y: 1, width: 315, height: 450 }, "STANDARD", "TEST00001", "CROP_OUT_OF_BOUNDS"],
    ["invalid-rotation", { unit: "pixel", x: 0, y: 0, width: 315, height: 450, rotation_degrees: 45 }, "STANDARD", "TEST00001", "INVALID_CROP_ROTATION"],
    ["rotation-overflow", { unit: "pixel", x: 100, y: 0, width: 385, height: 550, rotation_degrees: 90 }, "ROTATE_CLOCKWISE_B", "1SBP00424", "CROP_OUT_OF_BOUNDS"],
  ];

  for (const [label, crop, cropVariant, code, expectedError] of cases) {
    await t.test(label, async () => {
      const fixture = await createSceneCropFixture({ code, crop, cropVariant });
      try {
        await assert.rejects(
          generateSource(fixture.options),
          new RegExp(`SCENE_CROP:${code}:${expectedError}`),
        );
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

test("scene-crop accepts approved standard and 1SBP00424 rotated crops", async (t) => {
  const cases = [
    ["standard", "TEST00001", { unit: "pixel", x: 35, y: 0, width: 315, height: 450 }, "STANDARD"],
    ["rotate-clockwise-b", "1SBP00424", { unit: "pixel", x: 0, y: 0, width: 385, height: 550, rotation_degrees: 90 }, "ROTATE_CLOCKWISE_B"],
  ];
  for (const [label, code, crop, cropVariant] of cases) {
    await t.test(label, async () => {
      const fixture = await createSceneCropFixture({ code, crop, cropVariant });
      try {
        const generated = await generateSource(fixture.options);
        assert.equal(generated.humanRecords.length, 1);
        assert.equal(generated.humanRecords[0].code, code);
        assert.deepEqual(generated.humanRecords[0].crop_spec, crop);
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

test("1SBP00424 uses the approved 800x450 source and bounded clockwise crop", () => {
  const dimensions = readJpegDimensions(
    ROTATED_SCENE_SOURCE_JPEG,
    "1SBP00424_FIXTURE",
  );
  assert.deepEqual(dimensions, { width: 800, height: 450 });
  const rotatedDimensions = { width: dimensions.height, height: dimensions.width };
  assert.deepEqual(rotatedDimensions, { width: 450, height: 800 });
  const crop = { x: 0, y: 0, width: 385, height: 550 };
  assert.ok(crop.x + crop.width <= rotatedDimensions.width);
  assert.ok(crop.y + crop.height <= rotatedDimensions.height);
  assert.deepEqual(readJpegDimensions(ROTATED_SCENE_OUTPUT_JPEG), {
    width: 315,
    height: 450,
  });
  assert.equal(
    sha256(ROTATED_SCENE_OUTPUT_JPEG),
    "160f809f1fee99f77fd9716050a12946289ec0534ee7f28727f88b3a0fa62984",
  );
});

test("scene-crop approved output must be a valid 315x450 JPEG", async (t) => {
  const cases = [
    ["broken", Buffer.from("not-a-jpeg"), "INVALID_JPEG"],
    ["wrong-dimensions", SCENE_SOURCE_JPEG, "APPROVED_OUTPUT_DIMENSIONS_MISMATCH:800x450"],
  ];
  for (const [label, outputBytes, expectedError] of cases) {
    await t.test(label, async () => {
      const fixture = await createSceneCropFixture({ outputBytes });
      try {
        await assert.rejects(
          generateSource(fixture.options),
          new RegExp(`SCENE_CROP:TEST00001:APPROVED_OUTPUT:${expectedError}|SCENE_CROP:TEST00001:${expectedError}`),
        );
      } finally {
        await fixture.cleanup();
      }
    });
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
    const sceneCropFilePath = path.join(dataDirectory, "scene-crop.csv");
    const header =
      "product_code,expected_type,expected_source,decision_status,decision_basis,notes\n";
    const rowA = "AAA00001,sample,sample:1,confirmed,test,a\n";
    const rowB = "BBB00002,sample,sample:1,confirmed,test,b\n";
    await fs.writeFile(
      humanFilePath,
      "code,decision,accepted_mode,accepted_source_id,accepted_image_path,accepted_image_hash,approved_at,note,approval_pattern_id\n",
    );
    await fs.writeFile(overridesFilePath, "{}\n");
    await fs.writeFile(sceneCropFilePath, EMPTY_SCENE_CROP_HEADER);
    const options = {
      goldFilePath,
      humanFilePath,
      overridesFilePath,
      sceneCropFilePath,
      publicDirectory,
      repositoryDirectory: directory,
      expectedSceneCropCount: 0,
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

test("all 62 generated local READY assets are regular, in-tree, nonempty, and hash-matched", async () => {
  assert.equal(GENERATED_HUMAN_DECISION_RECORDS.length, 29);
  const generatedRecords = [
    ...GENERATED_GOLD_DECISION_RECORDS,
    ...GENERATED_HUMAN_DECISION_RECORDS,
  ];
  const localRecords = generatedRecords.filter(
    (record) =>
      record.state === "RESOLVED" &&
      record.output_path_or_url.startsWith("/card-thumbnails/"),
  );
  const externalRecords = generatedRecords.filter(
    (record) =>
      record.state === "RESOLVED" &&
      record.output_path_or_url.startsWith("https://pics.dmm.co.jp/"),
  );
  assert.equal(localRecords.length, 62);
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
