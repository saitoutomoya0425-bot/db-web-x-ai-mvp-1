"use client";

import { useEffect } from "react";

export default function SearchError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error("Search route error:", error); }, [error]);
  return (
    <main className="mx-auto max-w-3xl px-5 py-20 text-center">
      <h1 className="text-2xl font-bold">検索結果を表示できませんでした</h1>
      <p className="mt-3 text-slate-400">一時的な問題が発生しました。もう一度お試しください。</p>
      <button onClick={reset} className="mt-6 rounded-xl bg-violet-600 px-5 py-3 font-medium">再試行</button>
    </main>
  );
}
