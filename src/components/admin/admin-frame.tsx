"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, Bot, Clock3, Database, DownloadCloud, FileSpreadsheet, Gauge, HardDrive, Link2, SearchCheck, Settings2, ShieldAlert, SquarePlay, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";

const groups:{label:string;items:[string,string,LucideIcon][]}[]=[
  {label:"概要",items:[["/admin","ダッシュボード",Gauge]]},
  {label:"データ",items:[["/admin/works","作品管理",SquarePlay],["/admin/import-csv","CSVインポート",FileSpreadsheet],["/admin/fanza-import","FANZA少量取得",DownloadCloud],["/admin/sources","収集候補",Database],["/admin/ai-quality","AI品質管理",Bot]]},
  {label:"分析・収益",items:[["/admin/analytics","分析",Activity],["/admin/affiliate","アフィリエイト",Link2]]},
  {label:"システム",items:[["/admin/seo","SEO設定",SearchCheck],["/admin/api-settings","API設定",Settings2],["/admin/cron","Cron状況",Clock3],["/admin/errors","エラーログ",ShieldAlert],["/admin/backups","バックアップ",HardDrive],["/admin/users","ユーザー管理",Users]]},
];
export function AdminFrame({children}:{children:React.ReactNode}){
  const pathname=usePathname();
  if(pathname==="/admin/login")return children;
  return <div className="mx-auto flex max-w-[1600px] items-start"><aside className="sticky top-0 hidden h-screen w-64 shrink-0 overflow-y-auto border-r border-slate-800 bg-slate-950/95 p-4 lg:block"><Link href="/admin" className="block rounded-xl bg-violet-950/60 p-4"><p className="text-xs font-bold tracking-widest text-violet-400">OKAZU DB</p><p className="mt-1 font-black">運用コンソール</p></Link><AdminNav pathname={pathname}/></aside><div className="min-w-0 flex-1"><nav className="overflow-x-auto border-b border-slate-800 bg-slate-950 px-3 py-2 lg:hidden"><div className="flex min-w-max gap-2">{groups.flatMap(group=>group.items).map(([href,label])=><Link key={href} href={href} className={`rounded-lg px-3 py-2 text-xs ${pathname===href?"bg-violet-600":"bg-slate-900 text-slate-300"}`}>{label}</Link>)}</div></nav>{children}</div></div>;
}
function AdminNav({pathname}:{pathname:string}){return <nav className="mt-5 space-y-5">{groups.map(group=><div key={group.label}><p className="mb-2 px-3 text-[10px] font-bold tracking-widest text-slate-600">{group.label}</p><div className="space-y-1">{group.items.map(([href,label,Icon])=>{const active=pathname===href;return <Link key={href} href={href} className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm ${active?"bg-violet-600 text-white":"text-slate-400 hover:bg-slate-900 hover:text-white"}`}><Icon className="size-4"/>{label}</Link>})}</div></div>)}</nav>}
