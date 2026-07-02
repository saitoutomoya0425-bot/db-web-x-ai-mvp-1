import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import Papa from "papaparse";
import postgres from "postgres";

const file=process.argv[2],databaseUrl=process.env.SUPABASE_DB_URL;
if(!file)throw new Error("Usage: npm run import:videos -- /path/to/videos.csv");
if(!databaseUrl)throw new Error("SUPABASE_DB_URL is required");
const info=await stat(file),fingerprint=createHash("sha256").update(`${path.resolve(file)}:${info.size}:${info.mtimeMs}`).digest("hex");
const stateDirectory=path.resolve(".import-state");await mkdir(stateDirectory,{recursive:true});
const stateFile=path.join(stateDirectory,`${fingerprint}.json`);
const state=existsSync(stateFile)?JSON.parse(await readFile(stateFile,"utf8")):{processed:0,imported:0,duplicates:0,failed:0};
const sql=postgres(databaseUrl,{ssl:"require",max:2,prepare:false,idle_timeout:30,connect_timeout:20});
const columns=["product_code","title","actress_name","maker_name","series_name","label_name","genre","duration","release_date","sample_images","thumbnail_url","video_url","affiliate_url","description","popularity","favorite_count"];
const text=value=>String(value??"").trim()||null;
function normalize(raw,rowNumber){
  const product_code=text(raw.product_code)?.toUpperCase(),title=text(raw.title);
  if(!product_code||!title)return {error:`row ${rowNumber}: product_code and title are required`};
  const number=(value,nullable=false)=>{const parsed=text(value);if(!parsed)return nullable?null:0;const result=Number(parsed);return Number.isSafeInteger(result)&&result>=0?result:NaN};
  const duration=number(raw.duration,true),popularity=number(raw.popularity),favorite_count=number(raw.favorite_count);
  if([duration,popularity,favorite_count].some(value=>Number.isNaN(value)))return {error:`row ${rowNumber}: invalid numeric value`};
  const release_date=text(raw.release_date);if(release_date&&!/^\d{4}-\d{2}-\d{2}$/.test(release_date))return {error:`row ${rowNumber}: invalid release_date`};
  let sample_images=[];const samples=text(raw.sample_images);
  if(samples){try{const parsed=JSON.parse(samples);sample_images=Array.isArray(parsed)?parsed.map(String):[samples];}catch{sample_images=samples.split("|").map(value=>value.trim()).filter(Boolean);}}
  return {data:{product_code,title,actress_name:text(raw.actress_name),maker_name:text(raw.maker_name),series_name:text(raw.series_name),
    label_name:text(raw.label_name),genre:text(raw.genre),duration,release_date,sample_images,thumbnail_url:text(raw.thumbnail_url),
    video_url:text(raw.video_url),affiliate_url:text(raw.affiliate_url),description:text(raw.description),popularity,favorite_count},
    tags:(text(raw.tags)??"").split("|").map(value=>value.trim()).filter(Boolean).slice(0,100),actressKana:text(raw.actress_name_kana)};
}
async function flush(batch){
  if(!batch.length)return;
  await sql.begin(async transaction=>{
    const inserted=await transaction`insert into public.videos ${transaction(batch.map(item=>item.data),columns)}
      on conflict(product_code) do nothing returning product_code`;
    state.imported+=inserted.length;state.duplicates+=batch.length-inserted.length;
    const actressRows=[...new Map(batch.filter(item=>item.data.actress_name).map(item=>[item.data.actress_name,{name:item.data.actress_name,name_kana:item.actressKana}])).values()];
    const makerRows=[...new Set(batch.map(item=>item.data.maker_name).filter(Boolean))].map(name=>({name}));
    if(actressRows.length)await transaction`insert into public.actresses ${transaction(actressRows,["name","name_kana"])} on conflict(name) do update set name_kana=coalesce(excluded.name_kana,actresses.name_kana)`;
    if(makerRows.length)await transaction`insert into public.makers ${transaction(makerRows,["name"])} on conflict(name) do nothing`;
    const aliases=actressRows.filter(item=>item.name_kana&&item.name_kana!==item.name).map(item=>({entity_type:"actress",canonical_name:item.name,alias:item.name_kana}));
    if(aliases.length)await transaction`insert into public.entity_aliases ${transaction(aliases,["entity_type","canonical_name","alias"])} on conflict do nothing`;
    const tagNames=[...new Set(batch.flatMap(item=>item.tags))];
    if(tagNames.length){
      await transaction`insert into public.tags(name) select * from unnest(${tagNames}::text[]) on conflict(name) do nothing`;
      const codes=batch.map(item=>item.data.product_code);
      const [videos,tags]=await Promise.all([
        transaction`select id,product_code from public.videos where product_code in ${transaction(codes)}`,
        transaction`select id,name from public.tags where name in ${transaction(tagNames)}`,
      ]);
      const videoIds=new Map(videos.map(row=>[row.product_code,row.id])),tagIds=new Map(tags.map(row=>[row.name,row.id]));
      const links=batch.flatMap(item=>item.tags.flatMap(name=>{
        const video_id=videoIds.get(item.data.product_code),tag_id=tagIds.get(name);
        return video_id&&tag_id?[{video_id,tag_id}]:[];
      }));
      if(links.length)await transaction`insert into public.video_tags ${transaction(links,["video_id","tag_id"])} on conflict do nothing`;
    }
  });
  await writeFile(stateFile,JSON.stringify(state));
  console.log(`processed=${state.processed} imported=${state.imported} duplicates=${state.duplicates} failed=${state.failed}`);
}
try{
  await new Promise((resolve,reject)=>{
    let batch=[],seen=0,pending=Promise.resolve();
    Papa.parse(createReadStream(file),{header:true,skipEmptyLines:"greedy",
      step(result,parser){
        seen++;if(seen<=state.processed)return;
        state.processed++;const normalized=normalize(result.data,seen+1);
        if(normalized.error){state.failed++;return;}
        batch.push(normalized);
        if(batch.length>=1000){const current=batch;batch=[];parser.pause();pending=flush(current).then(()=>parser.resume()).catch(error=>{parser.abort();reject(error);});}
      },
      complete(){pending.then(()=>flush(batch)).then(resolve).catch(reject);},error:reject,
    });
  });
  console.log(`Import complete: ${JSON.stringify(state)}`);
}finally{await sql.end();}
