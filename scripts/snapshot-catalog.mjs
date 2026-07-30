import { createHash } from "node:crypto";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

const databaseUrl = process.env.SUPABASE_DB_URL;
if (!databaseUrl) throw new Error("SUPABASE_DB_URL is required");

const sql = postgres(databaseUrl, {
  ssl: "require",
  max: 1,
  prepare: false,
  idle_timeout: 20,
  connect_timeout: 20,
});
const tables = [
  "videos", "actresses", "makers", "series", "genres", "tags",
  "video_actresses", "video_tags", "video_genres", "data_sources",
  "source_products", "product_offers", "video_source_links",
];
const snapshot = {
  format: "okazu-db-catalog-snapshot-v1",
  created_at: new Date().toISOString(),
  tables: {},
};

try {
  for (const table of tables) {
    const [{ exists }] = await sql`
      select to_regclass(${`public.${table}`}) is not null as exists
    `;
    snapshot.tables[table] = exists
      ? await sql.unsafe(`select * from public."${table}" order by 1`)
      : null;
  }
  snapshot.migrations = await sql`
    select version, checksum, applied_at
    from public.app_schema_migrations
    order by version
  `;
} finally {
  await sql.end();
}

const directory = path.resolve("outputs/backups");
await mkdir(directory, { recursive: true });
const stamp = snapshot.created_at.replace(/[:.]/g, "-");
const file = path.join(directory, `catalog-before-027-${stamp}.json`);
const contents = `${JSON.stringify(snapshot, null, 2)}\n`;
await writeFile(file, contents, { mode: 0o600 });
await chmod(file, 0o600);
const digest = createHash("sha256").update(contents).digest("hex");
await writeFile(`${file}.sha256`, `${digest}  ${path.basename(file)}\n`, { mode: 0o600 });
await chmod(`${file}.sha256`, 0o600);

const videos = snapshot.tables.videos ?? [];
console.log(JSON.stringify({
  file,
  sha256_file: `${file}.sha256`,
  video_count: videos.length,
  published_count: videos.filter((row) => row.is_published).length,
  unpublished_count: videos.filter((row) => !row.is_published).length,
}));
