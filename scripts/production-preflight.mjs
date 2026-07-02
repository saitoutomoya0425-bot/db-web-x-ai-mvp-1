import { existsSync,readFileSync } from "node:fs";
const required=["NEXT_PUBLIC_SUPABASE_URL","NEXT_PUBLIC_SUPABASE_ANON_KEY","SUPABASE_SERVICE_ROLE_KEY","SUPABASE_DB_URL","NEXT_PUBLIC_SITE_URL","ADMIN_EMAIL","ADMIN_PASSWORD","CRON_SECRET","X_REPLY_API_KEY","INGEST_API_KEY"];
const automation=["OPENAI_API_KEY","X_BEARER_TOKEN","X_COLLECTION_QUERY","FANZA_API_ID","FANZA_AFFILIATE_ID"];
let failed=false;
for(const key of required){
  const value=process.env[key]?.trim();
  const placeholder=/your-|change-this|generate-a-|example\.com/i.test(value??"");
  const valid=Boolean(value)&&!placeholder&&!(key==="NEXT_PUBLIC_SITE_URL"&&(!value?.startsWith("https://")||/localhost|127\.0\.0\.1/.test(value)));
  console.log(`${valid?"ok":"missing"} ${key}`);if(!valid)failed=true;
}
if((process.env.ADMIN_PASSWORD?.length??0)<12){console.log("invalid ADMIN_PASSWORD (12 characters minimum)");failed=true}
for(const key of automation)console.log(`${process.env[key]?.trim()?"ok":"missing"} ${key} (automation)`);
for(const file of [".env.example","vercel.json","samples/videos.sample.csv","supabase/migrations/019_catalog_search_affiliate.sql"]){
  const valid=existsSync(file);console.log(`${valid?"ok":"missing"} ${file}`);if(!valid)failed=true;
}
try{
  const config=JSON.parse(readFileSync("vercel.json","utf8"));
  const valid=config.framework==="nextjs"&&Array.isArray(config.crons)&&config.crons.length===3;
  console.log(`${valid?"ok":"invalid"} vercel.json configuration`);if(!valid)failed=true;
}catch{console.log("invalid vercel.json");failed=true}
if(failed){console.error("Production preflight failed.");process.exitCode=1;}
else console.log("Production preflight passed.");
