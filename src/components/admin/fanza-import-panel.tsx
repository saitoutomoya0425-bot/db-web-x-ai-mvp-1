"use client";

import Image from "next/image";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { NormalizedFanzaProduct } from "@/lib/fanza/normalize";

type PreviewItem = {
  id: string;
  external_product_id: string;
  original_product_code: string | null;
  product_code: string | null;
  preview_status: string;
  review_status: string;
  normalized_data: unknown;
  fetched_at: string;
  error_message: string | null;
};
const labels: Record<string, string> = {
  new: "新規作品", update: "既存作品更新", unchanged: "変更なし",
  duplicate: "重複候補", needs_review: "要確認",
};
const colors: Record<string, string> = {
  new: "bg-emerald-950 text-emerald-300", update: "bg-blue-950 text-blue-300",
  unchanged: "bg-slate-800 text-slate-300", duplicate: "bg-orange-950 text-orange-300",
  needs_review: "bg-red-950 text-red-300",
};

export function FanzaImportPanel({ configured, items }: { configured: boolean; items: PreviewItem[] }) {
  const router = useRouter();
  const [limit, setLimit] = useState("10");
  const [keyword, setKeyword] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState(configured ? "" : "認証情報未設定のため取得テスト待ち");

  async function fetchTest() {
    setRunning(true); setMessage("公式APIから少量取得しています…");
    try {
      const response = await fetch("/api/admin/fanza/fetch", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: Number(limit), keyword: keyword || null }),
      });
      const data = await response.json();
      setMessage(response.ok ? data.message ?? `取得 ${data.fetched ?? 0}件・保存 ${data.saved ?? 0}件` : data.error ?? "取得に失敗しました");
      if (response.ok) router.refresh();
    } finally { setRunning(false); }
  }
  async function act(action: "promote" | "reject") {
    if (!selected.length) return;
    setRunning(true); setMessage("処理中…");
    try {
      const response = await fetch(`/api/admin/fanza/${action === "promote" ? "promote" : "review"}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(action === "promote" ? { ids: selected } : { ids: selected, action: "reject" }),
      });
      const data = await response.json();
      setMessage(response.ok ? `完了：${data.promoted ?? data.rejected ?? 0}件` : data.error ?? data.errors?.[0]?.message ?? "処理に失敗しました");
      if (response.ok) { setSelected([]); router.refresh(); }
    } finally { setRunning(false); }
  }
  const promotable = new Set(items.filter((item) => !["duplicate", "needs_review"].includes(item.preview_status)).map((item) => item.id));
  const selectedPromotable = selected.length > 0 && selected.every((id) => promotable.has(id));

  return <>
    <section className="mt-6 rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
      <h2 className="font-bold">少量取得テスト</h2>
      <p className="mt-2 text-sm text-slate-400">1回最大20件です。取得結果は候補領域だけに保存され、自動公開されません。</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-[120px_1fr_auto]">
        <select value={limit} onChange={(event) => setLimit(event.target.value)} disabled={running || !configured} className="h-11 rounded-lg border border-slate-700 bg-slate-950 px-3">
          <option value="10">10件</option><option value="20">20件</option>
        </select>
        <input value={keyword} onChange={(event) => setKeyword(event.target.value)} disabled={running || !configured} placeholder="任意の検索語（空欄なら新着）" className="h-11 rounded-lg border border-slate-700 bg-slate-950 px-3" />
        <button type="button" onClick={fetchTest} disabled={running || !configured} className="rounded-lg bg-violet-600 px-5 font-bold disabled:opacity-40">取得してプレビュー</button>
      </div>
      {message && <p className="mt-4 rounded-lg bg-slate-950 p-3 text-sm text-slate-300">{message}</p>}
    </section>

    <section className="mt-8">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => act("promote")} disabled={running || !selectedPromotable} className="rounded-lg bg-emerald-700 px-4 py-2 text-sm disabled:opacity-40">選択を承認して反映</button>
        <button type="button" onClick={() => act("reject")} disabled={running || !selected.length} className="rounded-lg bg-slate-800 px-4 py-2 text-sm disabled:opacity-40">選択を却下</button>
        <span className="text-xs text-slate-500">重複候補・要確認は承認できません</span>
      </div>
      <div className="space-y-3">
        {items.map((source) => {
          const item = source.normalized_data as NormalizedFanzaProduct;
          return <article key={source.id} className="grid gap-4 rounded-xl border border-slate-800 bg-slate-900/40 p-4 sm:grid-cols-[24px_96px_1fr]">
            <input aria-label={`${source.product_code ?? source.external_product_id}を選択`} type="checkbox" checked={selected.includes(source.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, source.id] : current.filter((id) => id !== source.id))} />
            <div className="relative aspect-[3/4] overflow-hidden rounded-lg bg-slate-950">
              {item.thumbnailUrl ? <Image src={item.thumbnailUrl} alt="" fill unoptimized className="object-cover" /> : <div className="grid h-full place-items-center text-xs text-slate-600">画像なし</div>}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap gap-2"><span className={`rounded-full px-2 py-1 text-xs ${colors[source.preview_status] ?? colors.needs_review}`}>{labels[source.preview_status] ?? source.preview_status}</span><span className="rounded-full bg-slate-800 px-2 py-1 text-xs">{source.review_status}</span></div>
              <p className="mt-3 font-mono text-sm text-violet-300">{source.product_code ?? "品番要確認"}</p>
              <h3 className="mt-1 font-bold">{item.title ?? "タイトル未取得"}</h3>
              <p className="mt-2 text-xs text-slate-400">女優：{item.actressNames.join("、") || "未取得"} / メーカー：{item.makerName ?? "未取得"} / シリーズ：{item.seriesName ?? "未取得"}</p>
              <p className="mt-1 text-xs text-slate-500">外部ID：{source.external_product_id} / 元品番：{source.original_product_code ?? "なし"} / 取得：{new Date(source.fetched_at).toLocaleString("ja-JP")}</p>
              {source.error_message && <p className="mt-2 text-xs text-red-300">{source.error_message}</p>}
            </div>
          </article>;
        })}
        {!items.length && <p className="rounded-xl border border-dashed border-slate-700 p-12 text-center text-slate-500">取得候補はまだありません。</p>}
      </div>
    </section>
  </>;
}
