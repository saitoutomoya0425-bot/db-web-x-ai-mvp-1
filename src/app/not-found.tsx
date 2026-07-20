import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "ページが見つかりません", robots: { index: false, follow: true } };

export default function NotFound() {
  return <main className="mx-auto max-w-2xl px-5 py-24 text-center">
    <p className="font-mono text-sm text-violet-400">404 NOT FOUND</p>
    <h1 className="mt-4 text-3xl font-black">ページが見つかりません</h1>
    <p className="mt-4 text-slate-400">URLが変更されたか、作品が現在公開されていない可能性があります。</p>
    <Link href="/" className="mt-8 inline-flex rounded-lg bg-violet-600 px-5 py-3 font-bold">トップへ戻る</Link>
  </main>;
}
