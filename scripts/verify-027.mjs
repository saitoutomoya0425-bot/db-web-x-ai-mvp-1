import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";

const databaseUrl = process.env.SUPABASE_DB_URL;
const snapshotPath = process.argv[2];
if (!databaseUrl || !snapshotPath) throw new Error("SUPABASE_DB_URL and snapshot path are required");

const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
const sql = postgres(databaseUrl, {
  ssl: "require",
  max: 1,
  prepare: false,
  idle_timeout: 20,
  connect_timeout: 20,
});
const fields = [
  "id", "product_code", "title", "actress_id", "maker_id", "series_id",
  "actress_name", "maker_name", "series_name", "label_name", "genre", "duration",
  "release_date", "sample_images", "thumbnail_url", "video_url", "official_url",
  "affiliate_url", "source_name", "external_product_id", "source_checked_at",
  "description", "popularity", "favorite_count", "is_published", "content_category",
  "created_at", "updated_at",
];
const canonical = (rows) => rows
  .map((row) => Object.fromEntries(fields.map((field) => [
    field,
    row[field] instanceof Date ? row[field].toISOString() : row[field],
  ])))
  .sort((left, right) => String(left.id).localeCompare(String(right.id)));
const digest = (rows) => createHash("sha256").update(JSON.stringify(canonical(rows))).digest("hex");

try {
  const videos = await sql`select * from public.videos order by id`;
  const [{ published, unpublished }] = await sql`
    select
      count(*) filter (where is_published)::int as published,
      count(*) filter (where not is_published)::int as unpublished
    from public.videos
  `;
  const [{ tables_ok }] = await sql`
    select (
      to_regclass('public.fanza_import_jobs') is not null
      and to_regclass('public.fanza_import_errors') is not null
      and to_regclass('public.video_actresses') is not null
    ) as tables_ok
  `;
  const [{ indexes_ok }] = await sql`
    select count(*) = 9 as indexes_ok
    from pg_indexes
    where schemaname = 'public'
      and indexname = any(array[
        'fanza_import_jobs_status_updated_idx',
        'fanza_import_errors_retry_idx',
        'video_actresses_actress_video_idx',
        'source_products_job_review_idx',
        'source_products_external_lookup_idx',
        'videos_published_title_trgm_idx',
        'videos_published_code_normalized_idx',
        'videos_published_series_popular_idx',
        'videos_published_genre_popular_idx'
      ])
  `;
  const rls = await sql`
    select relname, relrowsecurity
    from pg_class
    where relnamespace = 'public'::regnamespace
      and relname = any(array['fanza_import_jobs','fanza_import_errors','video_actresses'])
    order by relname
  `;
  const [privileges] = await sql`
    select
      has_function_privilege('anon', 'public.match_videos_for_import(text[],text[])', 'execute') as anon,
      has_function_privilege('authenticated', 'public.match_videos_for_import(text[],text[])', 'execute') as authenticated,
      has_function_privilege('service_role', 'public.match_videos_for_import(text[],text[])', 'execute') as service_role
  `;
  const [{ jobs, errors }] = await sql`
    select
      (select count(*)::int from public.fanza_import_jobs) as jobs,
      (select count(*)::int from public.fanza_import_errors) as errors
  `;
  const beforeVideos = snapshot.tables.videos ?? [];
  const unchanged = digest(beforeVideos) === digest(videos);
  const expectedSourceCount = (snapshot.tables.source_products ?? []).length;
  const [{ source_count }] = await sql`select count(*)::int as source_count from public.source_products`;
  console.log(JSON.stringify({
    migration_applied: true,
    tables_ok,
    indexes_ok,
    rls_ok: rls.length === 3 && rls.every((row) => row.relrowsecurity),
    rpc_privileges: privileges,
    video_count: videos.length,
    published_count: published,
    unpublished_count: unpublished,
    videos_unchanged: unchanged,
    source_products_unchanged: source_count === expectedSourceCount,
    fanza_import_jobs: jobs,
    fanza_import_errors: errors,
  }));
  if (!tables_ok || !indexes_ok || rls.length !== 3 || !rls.every((row) => row.relrowsecurity)
    || privileges.anon || privileges.authenticated || !privileges.service_role
    || videos.length !== 24 || published !== 10 || unpublished !== 14 || !unchanged
    || source_count !== expectedSourceCount || jobs !== 0 || errors !== 0) {
    process.exitCode = 1;
  }
} finally {
  await sql.end();
}
