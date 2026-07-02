"use client";

import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { AlertCircle, CheckCircle2, FileSpreadsheet, LoaderCircle, Upload, X } from "lucide-react";

type ImportResult = {
  imported: number;
  failed: number;
  total: number;
  errors: { row: number; product_code?: string; message: string }[];
};

export function CsvImporter() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [fatalError, setFatalError] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);

  function selectFile(event: ChangeEvent<HTMLInputElement>) {
    setFile(event.target.files?.[0] ?? null);
    setResult(null);
    setFatalError("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    setLoading(true);
    setResult(null);
    setFatalError("");
    const formData = new FormData();
    formData.set("file", file);
    try {
      const response = await fetch("/api/admin/import-csv", { method: "POST", body: formData });
      const body = await response.json();
      if (!response.ok) setFatalError(body.error ?? "インポートに失敗しました。");
      else setResult(body);
    } catch {
      setFatalError("通信に失敗しました。時間をおいて再度お試しください。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <button type="button" onClick={() => inputRef.current?.click()} className="grid min-h-56 w-full place-items-center rounded-2xl border-2 border-dashed border-slate-700 bg-slate-900/40 p-6 transition hover:border-violet-500 hover:bg-violet-950/10">
        <input ref={inputRef} type="file" accept=".csv,text/csv" onChange={selectFile} className="hidden" />
        {file ? (
          <div className="text-center"><FileSpreadsheet className="mx-auto size-12 text-emerald-400" /><p className="mt-4 font-semibold">{file.name}</p><p className="mt-1 text-sm text-slate-500">{(file.size / 1024).toFixed(1)} KB</p><span className="mt-4 inline-flex items-center gap-1 text-xs text-slate-400"><X className="size-3" />クリックして変更</span></div>
        ) : (
          <div className="text-center"><Upload className="mx-auto size-12 text-violet-400" /><p className="mt-4 font-semibold">CSVファイルを選択</p><p className="mt-2 text-sm text-slate-500">クリックして選択（最大5MB・2,000件）</p></div>
        )}
      </button>
      <button disabled={!file || loading} className="mt-5 inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-violet-600 font-bold transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40">{loading ? <LoaderCircle className="size-5 animate-spin" /> : <Upload className="size-5" />}{loading ? "登録中…" : "Supabaseへ一括登録"}</button>
      {fatalError && <div className="mt-6 flex gap-3 rounded-xl border border-red-900 bg-red-950/40 p-4 text-sm text-red-300"><AlertCircle className="size-5 shrink-0" />{fatalError}</div>}
      {result && (
        <div className="mt-8 space-y-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5"><p className="text-sm text-slate-500">CSV行数</p><p className="mt-2 text-3xl font-bold">{result.total}</p></div>
            <div className="rounded-xl border border-emerald-900 bg-emerald-950/20 p-5"><p className="flex items-center gap-2 text-sm text-emerald-400"><CheckCircle2 className="size-4" />登録件数</p><p className="mt-2 text-3xl font-bold text-emerald-300">{result.imported}</p></div>
            <div className="rounded-xl border border-red-900 bg-red-950/20 p-5"><p className="flex items-center gap-2 text-sm text-red-400"><AlertCircle className="size-4" />エラー件数</p><p className="mt-2 text-3xl font-bold text-red-300">{result.failed}</p></div>
          </div>
          {result.errors.length > 0 && <div className="overflow-hidden rounded-xl border border-red-900/70"><div className="bg-red-950/40 px-5 py-3 font-semibold text-red-300">エラー一覧</div><div className="max-h-80 overflow-auto"><table className="w-full text-left text-sm"><thead className="sticky top-0 bg-slate-900 text-slate-400"><tr><th className="px-5 py-3">行</th><th className="px-5 py-3">品番</th><th className="px-5 py-3">内容</th></tr></thead><tbody className="divide-y divide-slate-800">{result.errors.map((error, index) => <tr key={`${error.row}-${index}`}><td className="px-5 py-3">{error.row}</td><td className="px-5 py-3 font-mono">{error.product_code ?? "—"}</td><td className="px-5 py-3 text-red-300">{error.message}</td></tr>)}</tbody></table></div></div>}
        </div>
      )}
    </form>
  );
}
