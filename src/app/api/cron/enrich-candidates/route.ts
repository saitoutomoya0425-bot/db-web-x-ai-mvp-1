import { NextResponse } from "next/server";
import { runCandidateEnrichment } from "@/lib/ai/enrich";

export const runtime="nodejs";
export const maxDuration=60;
export async function GET(request:Request) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization")!==`Bearer ${process.env.CRON_SECRET}`) return NextResponse.json({error:"Unauthorized"},{status:401});
  try { return NextResponse.json(await runCandidateEnrichment(20)); }
  catch(error) { return NextResponse.json({error:error instanceof Error?error.message:String(error)},{status:500}); }
}
export const POST=GET;
