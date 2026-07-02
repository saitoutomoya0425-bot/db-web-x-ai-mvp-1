import { createClient } from "@/lib/supabase/server";
import { toWorkDetails } from "@/lib/queries/public-works";
export type CatalogSort="popular"|"new"|"release";
export async function getCatalogWorks(options:{limit?:number;offset?:number;sort?:CatalogSort;genre?:string;maker?:string}={}){
  const supabase=await createClient(),limit=Math.min(Math.max(options.limit??24,1),100),offset=Math.max(options.offset??0,0);
  let query=supabase.from("videos").select("*");
  if(options.genre)query=query.eq("genre",options.genre);
  if(options.maker)query=query.eq("maker_name",options.maker);
  if(options.sort==="new")query=query.order("created_at",{ascending:false});
  else if(options.sort==="release")query=query.order("release_date",{ascending:false,nullsFirst:false});
  else query=query.order("popularity",{ascending:false}).order("created_at",{ascending:false});
  const {data}=await query.range(offset,offset+limit-1);return toWorkDetails(data);
}
export async function getMakerFacets(limit=100,offset=0){
  const supabase=await createClient(),{data,error}=await supabase.rpc("get_catalog_makers",{result_limit:limit,result_offset:offset});
  if(!error)return data??[];
  const {data:fallback}=await supabase.from("makers").select("name").order("name").range(offset,offset+limit-1);
  return (fallback??[]).map(item=>({name:item.name,work_count:0,popularity:0}));
}
export async function getGenreFacets(limit=100,offset=0){
  const supabase=await createClient(),{data,error}=await supabase.rpc("get_catalog_genres",{result_limit:limit,result_offset:offset});
  if(!error)return data??[];
  const {data:fallback}=await supabase.from("videos").select("genre,popularity").not("genre","is",null).limit(1000);
  const counts=new Map<string,{name:string;work_count:number;popularity:number}>();
  for(const item of fallback??[]){if(!item.genre)continue;const current=counts.get(item.genre);counts.set(item.genre,{name:item.genre,work_count:(current?.work_count??0)+1,popularity:(current?.popularity??0)+Number(item.popularity??0)})}
  return [...counts.values()].sort((a,b)=>b.work_count-a.work_count).slice(offset,offset+limit);
}
