"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, PlayCircle, X } from "lucide-react";

function isDirectVideoUrl(value: string) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    return /\.(mp4|webm|ogg|ogv|m3u8)(\?.*)?$/i.test(url.pathname + url.search);
  } catch {
    return false;
  }
}

function PlayOverlay() {
  return (
    <span className="grid size-20 place-items-center rounded-full bg-white/92 text-slate-950 shadow-2xl shadow-black/40 ring-1 ring-black/10 backdrop-blur transition hover:scale-105 sm:size-24">
      <PlayCircle className="ml-1 size-11 sm:size-14" />
    </span>
  );
}

export function SampleVideoTrigger({ url, title }: { url: string | null | undefined; title: string }) {
  const [open, setOpen] = useState(false);
  const [fullscreenBlocked, setFullscreenBlocked] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const direct = useMemo(() => (url ? isDirectVideoUrl(url) : false), [url]);

  useEffect(() => {
    if (!open || !direct) return;
    const video = videoRef.current;
    if (!video) return;
    void video.play().catch(() => undefined);
    const requestFullscreen = video.requestFullscreen?.bind(video);
    if (requestFullscreen) {
      void requestFullscreen().catch(() => setFullscreenBlocked(true));
    } else {
      setFullscreenBlocked(true);
    }
  }, [direct, open]);

  if (!url) return null;

  if (!direct) {
    return (
      <a href={url} target="_blank" rel="noreferrer" aria-label="メイン画像から動画を開く" className="absolute inset-0 z-10 grid place-items-center bg-black/0 transition hover:bg-black/10 active:scale-[0.995]">
        <PlayOverlay />
      </a>
    );
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label="メイン画像から動画を開く" className="absolute inset-0 z-10 grid place-items-center bg-black/0 transition hover:bg-black/10 active:scale-[0.995]">
        <PlayOverlay />
      </button>
      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/85 p-3 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={`${title} サンプル動画`}>
          <div className="w-full max-w-5xl overflow-hidden rounded-2xl border border-white/10 bg-slate-950 shadow-2xl">
            <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
              <p className="truncate text-sm font-bold text-slate-100">{title}</p>
              <button type="button" onClick={() => setOpen(false)} className="grid size-9 place-items-center rounded-full bg-white/10 text-slate-200 hover:bg-white/15" aria-label="閉じる"><X className="size-5" /></button>
            </div>
            <video ref={videoRef} src={url} muted playsInline controls autoPlay className="aspect-video w-full bg-black" />
            {fullscreenBlocked && <div className="flex items-center gap-2 px-4 py-3 text-xs text-slate-400"><ExternalLink className="size-4" />端末の制限により自動全画面化できない場合は、動画プレイヤーの全画面ボタンをご利用ください。</div>}
          </div>
        </div>
      )}
    </>
  );
}
