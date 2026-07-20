"use client";

import { useState, type FormEvent } from "react";

export function ContactForm() {
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("sending"); setMessage("");
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/contact", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(Object.fromEntries(form.entries())),
    });
    const result = await response.json().catch(() => ({}));
    if (response.ok) {
      setStatus("sent"); setMessage("お問い合わせを受け付けました。内容を確認のうえ対応します。");
      event.currentTarget.reset();
    } else {
      setStatus("error"); setMessage(result.error ?? "送信できませんでした。時間をおいてお試しください。");
    }
  }
  return <form onSubmit={submit} className="mt-8 space-y-5 rounded-2xl border border-slate-800 bg-slate-900/40 p-5 sm:p-7">
    <div className="hidden" aria-hidden="true"><label>会社名<input name="company" tabIndex={-1} autoComplete="off" /></label></div>
    <label className="block"><span className="text-sm text-slate-300">お名前</span><input required name="name" maxLength={100} autoComplete="name" className="mt-2 h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3" /></label>
    <label className="block"><span className="text-sm text-slate-300">メールアドレス</span><input required type="email" name="email" maxLength={320} autoComplete="email" className="mt-2 h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3" /></label>
    <label className="block"><span className="text-sm text-slate-300">件名</span><select required name="subject" className="mt-2 h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3"><option value="一般のお問い合わせ">一般のお問い合わせ</option><option value="掲載情報の修正">掲載情報の修正</option><option value="権利・削除依頼">権利・削除依頼</option><option value="その他">その他</option></select></label>
    <label className="block"><span className="text-sm text-slate-300">お問い合わせ内容</span><textarea required name="message" minLength={10} maxLength={5000} rows={8} className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 p-3" /></label>
    <label className="flex items-start gap-3 text-sm text-slate-400"><input required type="checkbox" name="consent" value="yes" className="mt-1" /><span>プライバシーポリシーに同意して送信します。</span></label>
    <button disabled={status === "sending"} className="h-11 rounded-lg bg-violet-600 px-6 font-bold disabled:opacity-50">{status === "sending" ? "送信中…" : "送信する"}</button>
    {message && <p role="status" className={`rounded-lg p-3 text-sm ${status === "sent" ? "bg-emerald-950/40 text-emerald-300" : "bg-red-950/40 text-red-300"}`}>{message}</p>}
  </form>;
}
