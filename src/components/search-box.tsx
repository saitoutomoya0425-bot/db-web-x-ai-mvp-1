"use client";

import { useState, type FormEvent } from "react";
import { LoaderCircle, Search } from "lucide-react";
import { useRouter } from "next/navigation";

export function SearchBox() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const normalized = code.trim().toUpperCase();
    if (!normalized) return;
    setLoading(true);
    setError("");
    router.push(`/search?q=${encodeURIComponent(normalized)}`);
  }

  return (
    <form onSubmit={submit} className="mx-auto max-w-2xl">
      <div className="flex rounded-2xl border border-slate-700 bg-slate-900 p-2 shadow-2xl shadow-violet-950/40 focus-within:border-violet-500">
        <input value={code} onChange={(event) => setCode(event.target.value)} aria-label="検索" placeholder="品番・女優・メーカー・シリーズで検索" className="min-w-0 flex-1 bg-transparent px-4 text-base outline-none placeholder:text-slate-500" />
        <button disabled={loading} className="inline-flex h-12 items-center gap-2 rounded-xl bg-violet-600 px-5 font-medium hover:bg-violet-500 disabled:opacity-60">
          {loading ? <LoaderCircle className="size-5 animate-spin" /> : <Search className="size-5" />}検索
        </button>
      </div>
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
    </form>
  );
}
