import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv } from "../scripts/generate-thumbnail-production-registry.mjs";
import { buildThumbnailRenderContract } from "../src/lib/thumbnail/presentation.ts";
import { resolveThumbnailPresentation } from "../src/lib/thumbnail/presentation.ts";
import { thumbnailStructuredDataImage } from "../src/lib/thumbnail/structured-data.ts";
import {
  PRODUCTION_THUMBNAIL_DECISIONS,
  PRODUCTION_THUMBNAIL_REGISTRY_CONFLICTS,
} from "../src/lib/thumbnail/production-registry.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RIGHT = ["DSUVR00005","RLMP00012","KDMI00009AI","ALDN00607","CADV00954","JUR00822","MKMP00749","MIVE00001","NSFS00506","H_068MXGS01441"];
const CENTER = ["FCSS00015","OFJE00654","125UMD01014","13DSVR02006","1FNS00237","15AKND00002AI","172RWRK00165AI","1DLDSS00507","1IENFA40401","1MGNL00180","1MIST00526","1MIST52801","1NSBB00036","2DFDM00077","H_1240MILK00302"];
const FULL = ["1SDCA00014AI","1NPH00249","1IENEE65102","H_1834TK00141","H_1834TK00143"];

test("Phase 5F canary is the exact reviewed 10 RIGHT, 15 CENTER, 5 FULL set", async () => {
  const allRows = parseCsv(await fs.readFile(path.join(root, "data/thumbnail-phase5-reviewed-decisions.csv"), "utf8"));
  const rows = allRows.filter((row) => row.approval_batch === "phase5f-canary-30");
  assert.equal(allRows.length, 692);
  assert.equal(rows.length, 30);
  assert.deepEqual(rows.filter((row) => row.mode === "PACKAGE_RIGHT").map((row) => row.code), RIGHT);
  assert.deepEqual(rows.filter((row) => row.mode === "PACKAGE_CENTER").map((row) => row.code), CENTER);
  assert.deepEqual(rows.filter((row) => row.mode === "PACKAGE_FULL").map((row) => row.code), FULL);
  assert.equal(rows.some((row) => row.mode === "SAMPLE"), false);
  for (const row of rows) {
    assert.equal(row.apply, "true", row.code);
    assert.equal(row.review_status, "HUMAN_APPROVED", row.code);
    assert.equal(row.approved_by, "owner_delegated_via_chatgpt", row.code);
    assert.equal(row.approval_batch, "phase5f-canary-30", row.code);
    const decision = PRODUCTION_THUMBNAIL_DECISIONS.get(row.code);
    assert.equal(decision?.mode, row.mode, row.code);
    assert.equal(decision?.source_id, row.source_id, row.code);
    assert.equal(decision?.source_path_or_url, row.source_path_or_url, row.code);
    assert.equal(decision?.source_hash, row.source_hash, row.code);
    assert.equal(decision?.output_path_or_url, row.output_path_or_url, row.code);
    assert.equal(decision?.output_hash, row.output_hash, row.code);
    assert.equal(decision?.approval_status, "HUMAN_APPROVED", row.code);
    assert.equal(decision?.render_status, "READY", row.code);
    assert.equal(decision?.crop_spec, null, row.code);
    const surfaces = ["list", "search", "detail", "related", "recently-viewed"].map(() =>
      resolveThumbnailPresentation({
        code: row.code,
        legacy_runtime_override: null,
        legacy_card_url: "https://pics.dmm.co.jp/stale.jpg",
        legacy_thumbnail_url: "https://pics.dmm.co.jp/stale.jpg",
      })
    );
    for (const resolution of surfaces) {
      assert.equal(resolution.resolution_kind, "CANONICAL", row.code);
      assert.equal(resolution.resolved_url, row.output_path_or_url, row.code);
      assert.equal(resolution.mode, row.mode, row.code);
      assert.equal(resolution.source_id, row.source_id, row.code);
      const contract = buildThumbnailRenderContract(resolution);
      assert.equal(contract.src, row.output_path_or_url, row.code);
      assert.equal(
        contract.object_fit,
        row.mode === "PACKAGE_FULL" ? "contain" : "cover",
        row.code,
      );
      assert.equal(
        contract.object_position,
        row.mode === "PACKAGE_RIGHT" ? "right" : "center",
        row.code,
      );
      assert.equal(contract.crop_spec, null, row.code);
    }
    const structured = thumbnailStructuredDataImage(surfaces[0], new URL("https://example.test"));
    assert.equal(
      structured.image,
      row.output_path_or_url.startsWith("/")
        ? `https://example.test${row.output_path_or_url}`
        : row.output_path_or_url,
      row.code,
    );
  }
  assert.equal(PRODUCTION_THUMBNAIL_DECISIONS.size - allRows.length, 104);
  assert.equal(PRODUCTION_THUMBNAIL_DECISIONS.size, 796);
  assert.equal(PRODUCTION_THUMBNAIL_REGISTRY_CONFLICTS.length, 0);
});
