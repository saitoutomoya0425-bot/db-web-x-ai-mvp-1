import type { Metadata } from "next";
import "./globals.css";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
  title: { default: "おかずDB｜品番・女優・メーカーから作品検索", template: "%s｜おかずDB" },
  description: "品番から作品情報、女優、関連作品をすぐに確認",
  openGraph: { type: "website", locale: "ja_JP", siteName: "おかずDB", title: "おかずDB", description: "品番・女優・メーカー・シリーズから作品を検索" },
  twitter: { card: "summary_large_image" },
  alternates: { canonical: "/" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ja"><body className="min-h-screen antialiased"><SiteHeader />{children}<footer className="mt-20 border-t border-slate-800 py-10 text-center text-xs text-slate-500">© おかずDB</footer></body></html>;
}
