import { NextResponse } from "next/server";
import { runCandidateEnrichment } from "@/lib/ai/enrich";
import { createClient } from "@/lib/supabase/server";

export async function POST() {
  const supabase=await createClient();
  const {data:{user}}=await supabase.auth.getUser();
  if (!user || user.app_metadata?.role!=="admin") return NextResponse.json({error:"Unauthorized"},{status:401});
  try { return NextResponse.json(await runCandidateEnrichment(20)); }
  catch(error) { return NextResponse.json({error:error instanceof Error?error.message:String(error)},{status:500}); }
}
