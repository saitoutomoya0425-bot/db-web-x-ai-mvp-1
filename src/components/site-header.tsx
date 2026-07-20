"use client";
import Link from "next/link";
import { Clapperboard, Menu, Search, Trophy, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useState } from "react";

const navLinks = [
  { href: "/works", label: "作品一覧" },
  { href: "/rankings/actress", label: "女優" },
  { href: "/makers", label: "メーカー" },
  { href: "/genres", label: "ジャンル" },
  { href: "/ranking", label: "ランキング" },
  { href: "/#recently-viewed", label: "最近閲覧" },
];

export function SiteHeader() {
  const pathname=usePathname();
  const [open, setOpen] = useState(false);
  if(pathname.startsWith("/admin"))return null;
  return (
    <header className="border-b border-slate-800/80 bg-slate-950/85 backdrop-blur">
      <p className="bg-amber-950/40 px-3 py-1.5 text-center text-[11px] text-amber-200">18歳未満の方は利用できません</p>
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
        <Link href="/" className="flex items-center gap-2 font-bold" onClick={() => setOpen(false)}>
          <span className="grid size-9 place-items-center rounded-xl bg-violet-600"><Clapperboard className="size-5" /></span>
          おかずDB
        </Link>
        <nav className="hidden items-center gap-5 text-sm text-slate-300 md:flex">
          <Link href="/" className="flex items-center gap-1.5 hover:text-white"><Search className="size-4" />品番検索</Link>
          <Link href="/works" className="hover:text-white">作品一覧</Link>
          <Link href="/rankings/actress" className="hover:text-white">女優</Link>
          <Link href="/makers" className="hover:text-white">メーカー</Link>
          <Link href="/genres" className="hover:text-white">ジャンル</Link>
          <Link href="/ranking" className="flex items-center gap-1.5 hover:text-white"><Trophy className="size-4" />ランキング</Link>
          <Link href="/#recently-viewed" className="hover:text-white">最近閲覧</Link>
        </nav>
        <button type="button" onClick={() => setOpen((value) => !value)} className="grid size-10 place-items-center rounded-full border border-white/10 bg-white/[0.04] text-slate-200 md:hidden" aria-expanded={open} aria-label={open ? "メニューを閉じる" : "メニューを開く"}>
          {open ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
      </div>
      {open && (
        <nav className="border-t border-white/10 px-5 py-3 md:hidden" aria-label="スマホメニュー">
          <div className="mx-auto grid max-w-6xl grid-cols-2 gap-2">
            {navLinks.map((link) => (
              <Link key={link.href} href={link.href} onClick={() => setOpen(false)} className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-medium text-slate-200 active:scale-[0.985]">
                {link.label}
              </Link>
            ))}
          </div>
        </nav>
      )}
    </header>
  );
}
