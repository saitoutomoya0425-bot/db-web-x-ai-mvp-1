"use client";
import { useState } from "react";
import { RefreshCw } from "lucide-react";

export function RefreshMetricsButton() {
  const [state, setState] = useState("");
  async function refresh() {
    setState("集計中…");
    const response = await fetch("/api/admin/metrics", { method: "POST" });
    setState(response.ok ? "更新しました" : "更新に失敗しました");
    if (response.ok) location.reload();
  }
  return <button onClick={refresh} className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm"><RefreshCw className="size-4" />{state || "分析を再集計"}</button>;
}
