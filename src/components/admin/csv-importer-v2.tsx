"use client";

import Papa, { type Parser } from "papaparse";
import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { AlertCircle, FileSpreadsheet, LoaderCircle, Square, Upload } from "lucide-react";

type RowError = { row: number; product_code?: string; message: string };
type Totals = { processed: number; imported: number; updated: number; duplicates: number; failed: number };
const EMPTY: Totals = { processed: 0, imported: 0, updated: 0, duplicates: 0, failed: 0 };

async function fileFingerprint(file: File) {
  const size = 64 * 1024;
  const [first, last] = await Promise.all([file.slice(0, size).arrayBuffer(), file.slice(Math.max(0, file.size - size)).arrayBuffer()]);
  const metadata = new TextEncoder().encode(`${file.name}:${file.size}:${file.lastModified}`);
  const bytes = new Uint8Array(metadata.length + first.byteLength + last.byteLength);
  bytes.set(metadata); bytes.set(new Uint8Array(first), metadata.length); bytes.set(new Uint8Array(last), metadata.length + first.byteLength);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function CsvImporter() {
  const input = useRef<HTMLInputElement>(null);
  const parser = useRef<Parser | null>(null);
  const stopped = useRef(false);
  const [file, setFile] = useState<File | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [totals, setTotals] = useState<Totals>(EMPTY);
  const [errors, setErrors] = useState<RowError[]>([]);
  const [message, setMessage] = useState("");
  const [completed, setCompleted] = useState(false);
  const [duplicateMode, setDuplicateMode] = useState<"skip" | "update">("skip");
  const [relationMode, setRelationMode] = useState<"merge" | "replace">("merge");

  const post = async (body: unknown, retries = 0): Promise<Record<string, unknown>> => {
    try {
    const response = await fetch("/api/admin/csv-import-v2", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "インポートに失敗しました");
      return data;
    } catch (error) {
      if (!retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 750));
      return post(body, retries - 1);
    }
  };
  function choose(event: ChangeEvent<HTMLInputElement>) {
    setFile(event.target.files?.[0] ?? null); setProgress(0); setRemaining(null); setTotals(EMPTY); setErrors([]); setMessage(""); setCompleted(false);
  }
  function stop() { stopped.current = true; parser.current?.abort(); }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    setRunning(true); setMessage(""); setCompleted(false); stopped.current = false;
    let jobId = "";
    try {
      const start = await post({ action: "start", fileName: file.name, fileSize: file.size, fingerprint: `${await fileFingerprint(file)}:${duplicateMode}:${relationMode}` });
      jobId = String(start.jobId);
      const resume = Number(start.resumeOffset ?? 0);
      let current: Totals = { processed: resume, imported: Number(start.imported ?? 0), updated: Number(start.updated ?? 0), duplicates: Number(start.duplicates ?? 0), failed: Number(start.failed ?? 0) };
      let parsed = 0;
      setTotals(current);
      if (start.resumed) setMessage(`${resume.toLocaleString()}件目から再開しています。`);
      await new Promise<void>((resolve, reject) => Papa.parse<Record<string, string>>(file, {
        header: true, skipEmptyLines: "greedy", chunkSize: 4 * 1024 * 1024,
        chunk: async (result, handle) => {
          parser.current = handle; handle.pause();
          try {
            const startRow = parsed; parsed += result.data.length;
            const skip = Math.min(result.data.length, Math.max(0, resume - startRow));
            const pending = result.data.slice(skip);
            for (let index = 0; index < pending.length; index += 1000) {
              if (stopped.current) return resolve();
              const response = await post({ action: "chunk", jobId, duplicateMode, relationMode, rowOffset: startRow + skip + index, rows: pending.slice(index, index + 1000) }, 3);
              const cumulative = response.cumulative as Totals | undefined;
              if (jobId.startsWith("stateless-")) current = {
                processed: current.processed + Number(response.processed ?? 0),
                imported: current.imported + Number(response.imported ?? 0),
                updated: current.updated + Number(response.updated ?? 0),
                duplicates: current.duplicates + Number(response.duplicates ?? 0),
                failed: current.failed + Number(response.failed ?? 0),
              };
              else if (cumulative) current = cumulative;
              setTotals({ ...current });
              if (Array.isArray(response.errors)) setErrors((value) => [...value, ...(response.errors as RowError[])].slice(0, 1000));
            }
            const fraction = Math.min(1, result.meta.cursor / file.size);
            setProgress(Math.min(99, Math.round(fraction * 100)));
            if (fraction > 0 && parsed >= resume) setRemaining(Math.max(0, Math.round(parsed / fraction) - current.processed));
            handle.resume();
          } catch (error) { handle.abort(); reject(error); }
        },
        complete: () => resolve(),
        error: reject,
      }));
      if (stopped.current) {
        await post({ action: "fail", jobId, message: "Stopped" }).catch(() => undefined);
        setMessage("中断しました。同じファイルを選ぶと続きから再開できます。");
      } else {
        await post({ action: "complete", jobId, totalCount: parsed });
        setProgress(100); setRemaining(0); setCompleted(true); setMessage("インポートが完了しました。");
      }
    } catch (error) {
      if (jobId) await post({ action: "fail", jobId, message: String(error) }).catch(() => undefined);
      setMessage(error instanceof Error ? error.message : "インポートに失敗しました。同じファイルから再開できます。");
    } finally { setRunning(false); parser.current = null; }
  }

  return <form onSubmit={submit}>
    <button type="button" disabled={running} onClick={() => input.current?.click()} className="grid min-h-52 w-full place-items-center rounded-2xl border-2 border-dashed border-slate-700 bg-slate-900/40 p-6 hover:border-violet-500 disabled:opacity-50">
      <input ref={input} type="file" accept=".csv,text/csv" onChange={choose} className="hidden" />
      {file ? <div className="text-center"><FileSpreadsheet className="mx-auto size-12 text-emerald-400" /><p className="mt-3 font-bold">{file.name}</p><p className="text-sm text-slate-500">{(file.size / 1024 / 1024).toFixed(1)} MB</p></div> : <div className="text-center"><Upload className="mx-auto size-12 text-violet-400" /><p className="mt-3 font-bold">CSVファイルを選択</p><p className="text-sm text-slate-500">100万件以上・中断再開対応</p></div>}
    </button>
    <fieldset disabled={running} className="mt-4 grid gap-2 sm:grid-cols-2"><legend className="mb-2 text-sm font-bold">同じ品番がある場合</legend><label className={`cursor-pointer rounded-xl border p-4 text-sm ${duplicateMode==="skip"?"border-violet-500 bg-violet-950/30":"border-slate-800"}`}><input type="radio" name="duplicateMode" checked={duplicateMode==="skip"} onChange={()=>setDuplicateMode("skip")} className="mr-2"/>スキップ（推奨・既存データを保護）</label><label className={`cursor-pointer rounded-xl border p-4 text-sm ${duplicateMode==="update"?"border-amber-500 bg-amber-950/20":"border-slate-800"}`}><input type="radio" name="duplicateMode" checked={duplicateMode==="update"} onChange={()=>setDuplicateMode("update")} className="mr-2"/>更新（空欄は変更しない）</label></fieldset>
    {duplicateMode === "update" && <fieldset disabled={running} className="mt-4 grid gap-2 sm:grid-cols-2"><legend className="mb-2 text-sm font-bold">タグ・ジャンルの更新方法</legend><label className={`cursor-pointer rounded-xl border p-4 text-sm ${relationMode==="merge"?"border-violet-500 bg-violet-950/30":"border-slate-800"}`}><input type="radio" name="relationMode" checked={relationMode==="merge"} onChange={()=>setRelationMode("merge")} className="mr-2"/>追加（部分更新・推奨）</label><label className={`cursor-pointer rounded-xl border p-4 text-sm ${relationMode==="replace"?"border-amber-500 bg-amber-950/20":"border-slate-800"}`}><input type="radio" name="relationMode" checked={relationMode==="replace"} onChange={()=>setRelationMode("replace")} className="mr-2"/>置換（CSVに値がある項目のみ）</label></fieldset>}
    <p className="mt-3 text-xs leading-5 text-slate-500">空欄は既存値を保持します。削除する場合だけ「clear_fields」列に項目名を | 区切りで指定してください（例: thumbnail_url|tags）。</p>
    {running && <div className="mt-5"><div className="mb-2 flex justify-between text-sm"><span>{totals.processed.toLocaleString()}件処理済み・{remaining === null ? "残り計算中" : `残り約${remaining.toLocaleString()}件`}</span><span>{progress}%</span></div><div className="h-3 overflow-hidden rounded-full bg-slate-800"><div className="h-full bg-violet-500" style={{ width: `${progress}%` }} /></div></div>}
    <div className="mt-5 flex gap-3"><button disabled={!file || running} className="h-12 flex-1 rounded-xl bg-violet-600 font-bold disabled:opacity-40">{running ? <span className="inline-flex items-center gap-2"><LoaderCircle className="size-5 animate-spin" />分割登録中</span> : "Supabaseへ一括登録"}</button>{running && <button type="button" onClick={stop} className="inline-flex h-12 items-center gap-2 rounded-xl border border-red-800 px-5 text-red-300"><Square className="size-4" />中止</button>}</div>
    {message && <p className={`mt-5 rounded-xl p-4 text-sm ${completed ? "bg-emerald-950/40 text-emerald-300" : "bg-amber-950/40 text-amber-200"}`}>{message}</p>}
    {(running || completed) && <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-5">{[["処理", totals.processed], ["新規", totals.imported], ["更新", totals.updated], ["重複スキップ", totals.duplicates], ["エラー", totals.failed]].map(([label, count]) => <div key={String(label)} className="rounded-xl border border-slate-800 p-4"><p className="text-xs text-slate-500">{label}</p><p className="mt-1 text-2xl font-bold">{Number(count).toLocaleString()}</p></div>)}</div>}
    {errors.length > 0 && <div className="mt-5 max-h-72 overflow-auto rounded-xl border border-red-900"><div className="p-3 text-sm font-bold text-red-300"><AlertCircle className="mr-2 inline size-4" />エラー行</div>{errors.map((error, index) => <p key={`${error.row}-${index}`} className="border-t border-slate-800 px-4 py-2 text-xs">行{error.row} {error.product_code}：{error.message}</p>)}</div>}
  </form>;
}
