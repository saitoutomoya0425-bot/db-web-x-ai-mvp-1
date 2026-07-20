"use client";

import { useEffect } from "react";
import { SESSION_COOKIE } from "@/lib/analytics-session";

export function FunnelSession() {
  useEffect(() => {
    const current = document.cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${SESSION_COOKIE}=`));
    if (current) return;
    const session = crypto.randomUUID();
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${SESSION_COOKIE}=${encodeURIComponent(session)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
  }, []);
  return null;
}
