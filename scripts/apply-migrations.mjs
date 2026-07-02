import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

const databaseUrl=process.env.SUPABASE_DB_URL;
if(!databaseUrl){
  console.error("SUPABASE_DB_URL が未設定です。.env.local にSupabaseの直接接続URLを設定してください。");
  process.exit(1);
}
const checkOnly=!process.argv.includes("--apply");
const directory=path.resolve("supabase/migrations");
const files=(await readdir(directory)).filter(file=>/^\d+_.+\.sql$/.test(file)).sort();
const sql=postgres(databaseUrl,{ssl:"require",max:1,prepare:false,idle_timeout:20,connect_timeout:20});
const target=new URL(databaseUrl);
console.log(`Database target: ${target.hostname}${target.pathname}`);
if(checkOnly){
  try{
    const [{tracking}]=await sql`select to_regclass('public.app_schema_migrations') is not null as tracking`;
    const applied=tracking?await sql`select version from public.app_schema_migrations`:[];
    const versions=new Set(applied.map(row=>row.version));
    if(!tracking){
      const [{legacy}]=await sql`select to_regclass('public.videos') is not null as legacy`;
      if(legacy)for(const file of ["001_initial_schema.sql","002_x_reply_pivot.sql","003_create_videos.sql","004_admin_role_policy.sql","005_expand_videos_production.sql"])versions.add(file);
    }
    const pending=files.filter(file=>!versions.has(file));
    console.log(`Applied/adopted: ${versions.size}`);
    console.log(`Pending: ${pending.length}`);
    for(const file of pending)console.log(`  ${file}`);
    if(pending.length)process.exitCode=2;
  }finally{await sql.end();}
}else
try{
  await sql`select pg_advisory_lock(hashtext('okazu-db-migrations'))`;
  await sql`create table if not exists public.app_schema_migrations(
    version text primary key,checksum text not null,applied_at timestamptz not null default now()
  )`;
  const applied=await sql`select version,checksum from public.app_schema_migrations`;
  const checksums=new Map(applied.map(row=>[row.version,row.checksum]));
  if(!applied.length){
    const [{legacy}]=await sql`select to_regclass('public.videos') is not null as legacy`;
    if(legacy){
      const legacyFiles=["001_initial_schema.sql","002_x_reply_pivot.sql","003_create_videos.sql","004_admin_role_policy.sql","005_expand_videos_production.sql"];
      for(const file of legacyFiles){
        const contents=await readFile(path.join(directory,file),"utf8");
        const checksum=createHash("sha256").update(contents).digest("hex");
        await sql`insert into public.app_schema_migrations(version,checksum) values(${file},${checksum})`;
        checksums.set(file,checksum);
        console.log(`adopted legacy ${file}`);
      }
    }
  }
  for(const file of files){
    const contents=await readFile(path.join(directory,file),"utf8");
    const checksum=createHash("sha256").update(contents).digest("hex");
    const previous=checksums.get(file);
    if(previous&&previous!==checksum)throw new Error(`Applied migration changed: ${file}`);
    if(previous){console.log(`skip ${file}`);continue;}
    await sql.begin(async transaction=>{
      await transaction.unsafe(contents);
      await transaction`insert into public.app_schema_migrations(version,checksum) values(${file},${checksum})`;
    });
    console.log(`applied ${file}`);
  }
  console.log(`Migration complete: ${files.length} files`);
}finally{
  await sql`select pg_advisory_unlock(hashtext('okazu-db-migrations'))`.catch(()=>undefined);
  await sql.end();
}
