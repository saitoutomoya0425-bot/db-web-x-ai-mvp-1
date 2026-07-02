import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
const schema=z.object({query:z.string().trim().min(1).max(512),enabled:z.boolean()});
export async function PATCH(request:Request){const supabase=await createClient(),{data:{user}}=await supabase.auth.getUser();if(!user||user.app_metadata?.role!=="admin")return NextResponse.json({error:"Unauthorized"},{status:401});const parsed=schema.safeParse(await request.json().catch(()=>null));if(!parsed.success)return NextResponse.json({error:parsed.error.issues[0]?.message??"Invalid settings"},{status:400});const {error}=await supabase.from("collection_sources").upsert({source:"x",query:parsed.data.query,enabled:parsed.data.enabled},{onConflict:"source"});return error?NextResponse.json({error:error.message},{status:500}):NextResponse.json({updated:true});}
