import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const settingsSchema=z.object({
  high_threshold:z.number().min(.5).max(1),medium_threshold:z.number().min(0).max(.99),
  auto_approve_enabled:z.boolean(),auto_approve_threshold:z.number().min(.8).max(1),
  minimum_evaluated_samples:z.number().int().min(20).max(100000),minimum_precision:z.number().min(.8).max(1),
}).refine(value=>value.medium_threshold<value.high_threshold,{message:"中信頼閾値は高信頼閾値未満にしてください"})
  .refine(value=>value.auto_approve_threshold>=value.high_threshold,{message:"自動承認閾値は高信頼閾値以上にしてください"});

async function admin() {
  const supabase=await createClient(),{data:{user}}=await supabase.auth.getUser();
  return {supabase,user:user?.app_metadata?.role==="admin"?user:null};
}
export async function PATCH(request:Request) {
  const {supabase,user}=await admin();
  if(!user)return NextResponse.json({error:"Unauthorized"},{status:401});
  const parsed=settingsSchema.safeParse(await request.json().catch(()=>null));
  if(!parsed.success)return NextResponse.json({error:parsed.error.issues[0]?.message??"Invalid settings"},{status:400});
  const {error}=await supabase.from("ai_quality_settings").update({...parsed.data,updated_by:user.id,updated_at:new Date().toISOString()}).eq("id",true);
  return error?NextResponse.json({error:error.message},{status:500}):NextResponse.json({updated:true});
}
export async function POST() {
  const {supabase,user}=await admin();
  if(!user)return NextResponse.json({error:"Unauthorized"},{status:401});
  const {data,error}=await supabase.rpc("refresh_ai_quality_snapshot");
  return error?NextResponse.json({error:error.message},{status:500}):NextResponse.json({snapshot:data});
}
