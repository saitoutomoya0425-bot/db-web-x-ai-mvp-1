"use client";

import { useState, type FormEvent } from "react";
import { Database, LoaderCircle, LogIn } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export default function AdminLoginPage() {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const supabase = createClient();
    const { data, error: loginError } = await supabase.auth.signInWithPassword({
      email: String(form.get("email")),
      password: String(form.get("password")),
    });
    if (loginError) {
      setError("メールアドレスまたはパスワードが正しくありません。");
      setLoading(false);
      return;
    }
    if (data.user.app_metadata?.role !== "admin") {
      await supabase.auth.signOut();
      setError("このアカウントには管理者権限がありません。");
      setLoading(false);
      return;
    }
    window.location.href = new URLSearchParams(window.location.search).get("next") ?? "/admin/import-csv";
  }

  return (
    <main className="grid min-h-[calc(100vh-4rem)] place-items-center bg-[radial-gradient(circle_at_top,#2e1065,#020617_50%)] p-5">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-950/90 p-7 shadow-2xl">
        <div className="mb-7 flex items-center gap-3"><span className="grid size-11 place-items-center rounded-xl bg-violet-600"><Database /></span><div><h1 className="font-bold">管理者ログイン</h1><p className="text-xs text-slate-500">おかずDB Admin</p></div></div>
        <label className="block text-sm">メールアドレス<input name="email" type="email" required className="mt-2 h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 outline-none focus:border-violet-500" /></label>
        <label className="mt-4 block text-sm">パスワード<input name="password" type="password" required className="mt-2 h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 outline-none focus:border-violet-500" /></label>
        {error && <p className="mt-4 rounded-lg bg-red-950/60 p-3 text-sm text-red-300">{error}</p>}
        <button disabled={loading} className="mt-6 inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-violet-600 font-medium hover:bg-violet-500 disabled:opacity-60">{loading ? <LoaderCircle className="size-5 animate-spin" /> : <LogIn className="size-5" />}ログイン</button>
      </form>
    </main>
  );
}
