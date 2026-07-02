import { NextResponse } from "next/server";
import { z } from "zod";
import { runCandidateEnrichment } from "@/lib/ai/enrich";
import { collectRecentXPosts } from "@/lib/collectors/x";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const schema=z.discriminatedUnion("action",[
  z.object({action:z.literal("collect")}),z.object({action:z.literal("enrich")}),
  z.object({action:z.literal("metrics")}),z.object({action:z.literal("affiliate")}),
  z.object({action:z.literal("affiliate-settings"),enabled:z.boolean(),affiliate_id:z.string().trim().max(200).nullable(),url_template:z.string().trim().url().nullable()}),
]);
export async function POST(request:Request){
  const client=await createClient(),{data:{user}}=await client.auth.getUser();
  if(!user||user.app_metadata?.role!=="admin")return NextResponse.json({error:"Unauthorized"},{status:401});
  const parsed=schema.safeParse(await request.json().catch(()=>null));
  if(!parsed.success)return NextResponse.json({error:parsed.error.issues[0]?.message??"Invalid action"},{status:400});
  const admin=createAdminClient();
  try{
    if(parsed.data.action==="enrich")return NextResponse.json(await runCandidateEnrichment(20));
    if(parsed.data.action==="metrics"){
      const results=await Promise.all([admin.rpc("refresh_discovery_metrics"),admin.rpc("refresh_keyword_metrics"),admin.rpc("refresh_ai_quality_snapshot")]);
      const error=results.find(result=>result.error)?.error;if(error)throw new Error(error.message);
      return NextResponse.json({refreshed:true});
    }
    if(parsed.data.action==="affiliate"){
      const {data,error}=await admin.rpc("apply_affiliate_template",{batch_limit:50000});if(error)throw new Error(error.message);
      return NextResponse.json({updated:data});
    }
    if(parsed.data.action==="affiliate-settings"){
      if(parsed.data.enabled&&(!parsed.data.affiliate_id||!parsed.data.url_template||!parsed.data.url_template.includes("{product_code}")||!parsed.data.url_template.includes("{affiliate_id}")))return NextResponse.json({error:"IDと、{product_code}・{affiliate_id} を含むURLテンプレートが必要です"},{status:400});
      const {error}=await client.from("affiliate_settings").update({enabled:parsed.data.enabled,affiliate_id:parsed.data.affiliate_id,url_template:parsed.data.url_template,updated_by:user.id,updated_at:new Date().toISOString()}).eq("id",true);
      if(error)throw new Error(error.message);return NextResponse.json({updated:true});
    }
    const {data:source}=await admin.from("collection_sources").select("*").eq("source","x").maybeSingle();
    const query=source?.query||process.env.X_COLLECTION_QUERY;if(!query)throw new Error("X_COLLECTION_QUERY is not configured");
    const result=await collectRecentXPosts({query,sinceId:source?.since_id,maxPages:5});
    await admin.from("collection_sources").upsert({source:"x",query,since_id:result.newestId??source?.since_id??null,enabled:true,last_run_at:new Date().toISOString(),next_run_at:result.rateLimitReset,last_error:null},{onConflict:"source"});
    return NextResponse.json(result);
  }catch(error){return NextResponse.json({error:error instanceof Error?error.message:String(error)},{status:500});}
}
