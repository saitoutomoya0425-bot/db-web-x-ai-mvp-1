"use client";

import { useEffect, useState, type FormEvent } from "react";
import { LoaderCircle, Search } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export function SearchBox() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(false);
  }, [pathname, searchParams]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const normalized = code.trim().toUpperCase();
    if (!normalized) return;
    setLoading(true);
    setError("");
    const target = `/search?q=${encodeURIComponent(normalized)}`;
    const current = `${pathname}?${searchParams.toString()}`;
    router.push(target);
    if (current === target) {
      setLoading(false);
      return;
    }
    window.setTimeout(() => setLoading(false), 1800);
  }

  return (
    <form onSubmit={submit} className="mx-auto max-w-3xl">
      <div className="flex rounded-[26px] border border-white/10 bg-white/[0.06] p-2 shadow-2xl shadow-violet-950/30 backdrop-blur focus-within:border-violet-400/80 focus-within:bg-white/[0.075]">
        <input value={code} onChange={(event) => setCode(event.target.value)} aria-label="検索" placeholder="品番・女優・メーカー・ジャンルを入力" className="min-w-0 flex-1 bg-transparent px-4 text-base outline-none placeholder:text-slate-500 sm:px-5" />
        <button disabled={loading} className="inline-flex h-12 shrink-0 items-center gap-2 rounded-[18px] bg-violet-600 px-5 font-bold shadow-lg shadow-violet-950/30 transition hover:bg-violet-500 disabled:opacity-60 sm:px-6">
          {loading ? <LoaderCircle className="size-5 animate-spin" /> : <Search className="size-5" />}検索
        </button>
      </div>
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
    </form>
  );
}
