"use client";
import Link from "next/link";
import { Clapperboard, Search, Trophy } from "lucide-react";
import { usePathname } from "next/navigation";

export function SiteHeader() {
  const pathname=usePathname();
  if(pathname.startsWith("/admin"))return null;
  return (
    <header className="border-b border-slate-800/80 bg-slate-950/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
        <Link href="/" className="flex items-center gap-2 font-bold">
          <span className="grid size-9 place-items-center rounded-xl bg-violet-600"><Clapperboard className="size-5" /></span>
          おかずDB
        </Link>
        <nav className="flex items-center gap-5 text-sm text-slate-300">
          <Link href="/" className="flex items-center gap-1.5 hover:text-white"><Search className="size-4" />品番検索</Link>
          <Link href="/works" className="hidden hover:text-white sm:block">作品一覧</Link>
          <Link href="/makers" className="hidden hover:text-white md:block">メーカー</Link>
          <Link href="/genres" className="hidden hover:text-white md:block">ジャンル</Link>
          <Link href="/ranking" className="flex items-center gap-1.5 hover:text-white"><Trophy className="size-4" />ランキング</Link>
          <Link href="/rankings" className="hidden hover:text-white sm:block">女優・メーカー</Link>
        </nav>
      </div>
    </header>
  );
}
