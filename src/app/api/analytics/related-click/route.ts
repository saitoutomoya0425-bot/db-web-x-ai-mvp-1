import { NextResponse } from "next/server";
import { sessionFromCookieHeader } from "@/lib/analytics-session";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { videoId?: unknown; relatedVideoId?: unknown; source?: unknown; referrer?: unknown };
    const videoId = typeof body.videoId === "string" ? body.videoId : "";
    const relatedVideoId = typeof body.relatedVideoId === "string" ? body.relatedVideoId : "";
    if (!/^[0-9a-f-]{36}$/i.test(videoId) || !/^[0-9a-f-]{36}$/i.test(relatedVideoId) || videoId === relatedVideoId) {
      return NextResponse.json({ error: "Invalid video" }, { status: 400 });
    }
    const { error } = await createAdminClient().from("related_video_clicks").insert({
      video_id: videoId,
      related_video_id: relatedVideoId,
      session_id: sessionFromCookieHeader(request.headers.get("cookie")),
      source: typeof body.source === "string" ? body.source.slice(0, 50) : "related",
      referrer: typeof body.referrer === "string" ? body.referrer.slice(0, 1000) : request.headers.get("referer")?.slice(0, 1000) ?? null,
    });
    if (error) throw error;
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error("related click tracking failed", error);
    return NextResponse.json({ error: "Tracking unavailable" }, { status: 503 });
  }
}
