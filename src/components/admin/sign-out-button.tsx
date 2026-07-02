"use client";

import { LogOut } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export function SignOutButton() {
  async function signOut() {
    await createClient().auth.signOut();
    window.location.href = "/admin/login";
  }
  return <button onClick={signOut} className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:text-white"><LogOut className="size-4" />ログアウト</button>;
}
