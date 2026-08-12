import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  fanzaWindowEndOffset,
  normalizeFanzaPaginationOptions,
  parseFanzaPaginationCli,
} from "../src/lib/fanza/pagination.ts";

test("offset 1 remains the compatible default", () => {
  assert.deepEqual(normalizeFanzaPaginationOptions(), {
    startOffset: 1,
    maxItems: 100,
    pageSize: 100,
    sort: "date",
  });
  assert.equal(parseFanzaPaginationCli(["25"]).maxItems, 25);
});

test("custom start offset and date ordering define one reproducible window", () => {
  const options = parseFanzaPaginationCli([
    "--start-offset=1001",
    "--max-items=1000",
    "--page-size=100",
    "--sort=date",
  ]);
  assert.deepEqual(options, { startOffset: 1001, maxItems: 1000, pageSize: 100, sort: "date" });
  assert.equal(fanzaWindowEndOffset(options), 2000);
});

test("page boundaries and maxItems are independently validated", () => {
  assert.deepEqual(parseFanzaPaginationCli([
    "--start-offset=101", "--max-items=1", "--page-size=1",
  ]), { startOffset: 101, maxItems: 1, pageSize: 1, sort: "date" });
  assert.throws(() => parseFanzaPaginationCli(["--page-size=101"]), /PAGE_SIZE_1_TO_100_REQUIRED/);
  assert.throws(() => parseFanzaPaginationCli(["--max-items=0"]), /MAX_ITEMS_1_TO_1000000_REQUIRED/);
});

test("unsupported sort and ambiguous maxItems are rejected", () => {
  assert.throws(() => parseFanzaPaginationCli(["--sort=rank"]), /FANZA_SORT_UNSUPPORTED/);
  assert.throws(() => parseFanzaPaginationCli(["100", "--max-items=100"]), /MAX_ITEMS_SPECIFIED_TWICE/);
});

test("dry-run and candidate-save scripts share the same start-offset parser", async () => {
  for (const path of ["../scripts/fanza-dry-run-100.mjs", "../scripts/fanza-save-candidates-100.mjs"]) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(source, /parseFanzaPaginationCli/);
    assert.match(source, /pagination\.startOffset/);
    assert.doesNotMatch(source, /let offset = 1/);
  }
});

test("job creation stores the requested startOffset in the existing resume checkpoint", async () => {
  const source = await readFile(new URL("../src/app/api/admin/fanza/jobs/route.ts", import.meta.url), "utf8");
  assert.match(source, /startOffset: z\.number\(\)\.int\(\)\.min\(1\)\.default\(1\)/);
  assert.match(source, /next_offset: parsed\.data\.startOffset/);
});
