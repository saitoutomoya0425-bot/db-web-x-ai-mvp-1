"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  ["/about", "サイトについて"],
  ["/contact", "お問い合わせ"],
  ["/privacy", "プライバシーポリシー"],
  ["/disclaimer", "免責事項・広告掲載方針"],
] as const;

export function SiteFooter() {
  const pathname = usePathname();
  if (pathname.startsWith("/admin")) return null;
  return <footer className="mt-20 border-t border-slate-800 bg-slate-950/70">
    <div className="mx-auto max-w-6xl px-5 py-10">
      <p className="rounded-lg border border-amber-900/60 bg-amber-950/20 px-4 py-3 text-center text-xs text-amber-200">当サイトは成人向け作品情報を扱います。18歳未満の方は利用できません。</p>
      <nav className="mt-6 flex flex-wrap justify-center gap-x-6 gap-y-3 text-sm text-slate-400" aria-label="サイト情報">
        {links.map(([href, label]) => <Link key={href} href={href} className="inline-flex min-h-8 items-center hover:text-white">{label}</Link>)}
      </nav>
      <p className="mt-6 text-center text-xs text-slate-500">
        Powered by{" "}
        <a href="https://affiliate.dmm.com/api/" target="_blank" rel="noreferrer" className="underline decoration-slate-700 underline-offset-4 hover:text-slate-300">
          FANZA Webサービス
        </a>
      </p>
      <p className="mt-7 text-center text-xs text-slate-500">© おかずDB</p>
    </div>
  </footer>;
}
