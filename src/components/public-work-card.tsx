import Image from "next/image";
import Link from "next/link";
import { ImageIcon } from "lucide-react";
import type { WorkDetail } from "@/types/database";

export function PublicWorkCard({ work, rank, count }: { work: WorkDetail; rank?: number; count?: number }) {
  return (
    <Link href={`/work/${encodeURIComponent(work.product_code)}`} className="group overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60 transition hover:-translate-y-1 hover:border-violet-700">
      <div className="relative aspect-[16/10] overflow-hidden bg-slate-900">
        {work.thumbnail_url ? <Image src={work.thumbnail_url} alt={work.title} fill unoptimized className="object-cover transition duration-300 group-hover:scale-105" /> : <div className="grid h-full place-items-center text-slate-700"><ImageIcon className="size-10" /></div>}
        {rank && <span className="absolute left-3 top-3 grid size-9 place-items-center rounded-full bg-violet-600 font-bold shadow-lg">#{rank}</span>}
      </div>
      <div className="p-4">
        <span className="font-mono text-xs text-violet-300">{work.product_code}</span>
        <h3 className="mt-2 line-clamp-2 min-h-12 font-semibold leading-6">{work.title}</h3>
        <div className="mt-3 space-y-1 text-xs text-slate-400">
          <div className="flex justify-between"><span>{work.actresses?.name ?? "女優未設定"}</span>{typeof count === "number" && <span>{count} searches</span>}</div>
          <p className="truncate text-slate-500">{work.makers?.name ?? "メーカー未設定"}</p>
        </div>
      </div>
    </Link>
  );
}
