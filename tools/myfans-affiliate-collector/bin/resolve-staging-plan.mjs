#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import postgres from "postgres";

import { dryRunCatalogImport } from "../importer/dry-run-importer.mjs";
import { resolutionSummary, resolveStagingPlan } from "../importer/read-only-resolution.mjs";

const args = process.argv.slice(2);
const summaryOnly = args.includes("--summary-only");
const positional = args.filter((argument) => !argument.startsWith("--"));

if (args.includes("--help") || positional.length !== 1) {
  process.stdout.write(
    "Usage: node tools/myfans-affiliate-collector/bin/resolve-staging-plan.mjs <myfans-affiliate-catalog-*.json> [--summary-only]\n"
  );
  process.exitCode = args.includes("--help") ? 0 : 2;
} else if (!process.env.SUPABASE_DB_URL) {
  process.stderr.write("SUPABASE_DB_URL is required for read-only resolution\n");
  process.exitCode = 2;
} else {
  const inputPath = positional[0];
  const fileName = basename(inputPath);
  if (!/^myfans-affiliate-catalog-.+[.]json$/.test(fileName)) {
    process.stderr.write("Input filename must match myfans-affiliate-catalog-*.json\n");
    process.exitCode = 2;
  } else {
    const sql = postgres(process.env.SUPABASE_DB_URL, {
      ssl: "require",
      max: 1,
      prepare: false,
      connect_timeout: 20,
      idle_timeout: 20
    });
    let queryCount = 0;
    try {
      const raw = await readFile(inputPath);
      const bundle = JSON.parse(raw.toString("utf8"));
      const dryRun = dryRunCatalogImport(bundle, {
        fileName,
        fileSha256: createHash("sha256").update(raw).digest("hex")
      });

      queryCount += 1;
      const dataSourceCandidates = await sql`
        select id, name, source_type, is_active
        from public.data_sources
        where lower(name) like ${"%myfans%"}
           or lower(coalesce(terms_note, '')) like ${"%myfans%"}
        order by name
      `;

      let creators = [];
      let posts = [];
      if (dryRun.normalization_pass && dataSourceCandidates.length === 1) {
        const dataSourceId = dataSourceCandidates[0].id;
        const creatorExternalIds = dryRun.targets.myfans_creators.map(
          (target) => target.db_row.external_creator_id
        );
        const profileSlugs = dryRun.targets.myfans_creators.map((target) => target.db_row.profile_slug);
        const profileUrls = dryRun.targets.myfans_creators.map((target) => target.db_row.official_url);
        const postExternalIds = dryRun.targets.myfans_posts.map(
          (target) => target.db_row.external_post_id
        );

        queryCount += 1;
        creators = await sql`
          select id, data_source_id, external_creator_id, profile_slug, display_name,
                 official_url, profile_image_url, bio, visibility, review_status,
                 raw_public_metadata, metadata_hash, fetched_at
          from public.myfans_creators
          where data_source_id = ${dataSourceId}
            and (
              external_creator_id in ${sql(creatorExternalIds)}
              or lower(profile_slug) in ${sql(profileSlugs.map((value) => value.toLowerCase()))}
              or official_url in ${sql(profileUrls)}
            )
        `;

        queryCount += 1;
        posts = await sql`
          select p.id, p.data_source_id, p.creator_id, p.external_post_id,
                 p.source_product_id, p.title, p.teaser, p.official_url,
                 p.thumbnail_url, p.published_at, p.content_type, p.media_indicator,
                 p.sample_available, p.visibility, p.price, p.currency,
                 p.review_status, p.raw_public_metadata, p.metadata_hash, p.fetched_at
          from public.myfans_posts p
          where p.data_source_id = ${dataSourceId}
            and p.external_post_id in ${sql(postExternalIds)}
        `;
      }

      const report = resolveStagingPlan(
        dryRun,
        { dataSourceCandidates, creators, posts },
        { dbQueryCount: queryCount }
      );
      process.stdout.write(`${JSON.stringify(summaryOnly ? resolutionSummary(report) : report, null, 2)}\n`);
      if (report.status !== "READY") process.exitCode = 1;
    } catch (error) {
      process.stderr.write(`Read-only resolution error: ${error.message}\n`);
      process.exitCode = 2;
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
}
