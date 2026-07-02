"use client";
import { useState } from "react";
export function BackupButton(){const [message,setMessage]=useState("");async function run(){setMessage("作成中…");const response=await fetch("/api/admin/backups",{method:"POST"});const data=await response.json();setMessage(response.ok?`マニフェストを作成しました: ${data.id}`:data.error);if(response.ok)location.reload()}return <><button onClick={run} className="rounded-lg bg-violet-600 px-5 py-2.5 text-sm font-bold">バックアップマニフェスト作成</button>{message&&<p className="mt-3 text-sm text-slate-400">{message}</p>}</>}
