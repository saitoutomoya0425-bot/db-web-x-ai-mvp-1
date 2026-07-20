"use client";

import { useEffect } from "react";

export function VideoViewTracker({ videoId }: { videoId: string }) {
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/analytics/video-view", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ videoId, source: "work_detail", referrer: document.referrer || null }),
      keepalive: true,
      signal: controller.signal,
    }).catch(() => undefined);
    return () => controller.abort();
  }, [videoId]);
  return null;
}
