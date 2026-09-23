#!/usr/bin/env node

import { createHash } from "node:crypto";
import { basename } from "node:path";
import { readFile } from "node:fs/promises";

import { dryRunCatalogImport, summaryOnly } from "../importer/dry-run-importer.mjs";

const args = process.argv.slice(2);
const summary = args.includes("--summary-only");
const positional = args.filter((argument) => !argument.startsWith("--"));

if (args.includes("--help") || positional.length !== 1) {
  process.stdout.write(
    "Usage: node tools/myfans-affiliate-collector/bin/dry-run-import.mjs <myfans-affiliate-catalog-*.json> [--summary-only]\n"
  );
  process.exitCode = args.includes("--help") ? 0 : 2;
} else {
  const inputPath = positional[0];
  const fileName = basename(inputPath);
  if (!/^myfans-affiliate-catalog-.+[.]json$/.test(fileName)) {
    process.stderr.write("Input filename must match myfans-affiliate-catalog-*.json\n");
    process.exitCode = 2;
  } else {
    try {
      const raw = await readFile(inputPath);
      const bundle = JSON.parse(raw.toString("utf8"));
      const report = dryRunCatalogImport(bundle, {
        fileName,
        fileSha256: createHash("sha256").update(raw).digest("hex")
      });
      process.stdout.write(`${JSON.stringify(summary ? summaryOnly(report) : report, null, 2)}\n`);
      if (!report.normalization_pass) process.exitCode = 1;
    } catch (error) {
      process.stderr.write(`Dry-run input error: ${error.message}\n`);
      process.exitCode = 2;
    }
  }
}
