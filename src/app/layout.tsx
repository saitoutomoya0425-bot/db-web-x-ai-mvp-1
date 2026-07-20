import type { Metadata } from "next";
import "./globals.css";
import { SiteHeader } from "@/components/site-header";
import { FunnelSession } from "@/components/funnel-session";
import { SiteFooter } from "@/components/site-footer";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
  title: { default: "おかずDB｜成人向け作品情報データベース", template: "%s｜おかずDB" },
  description: "成人向け作品を品番、女優名、メーカー、シリーズ、ジャンルから検索・閲覧できる作品情報データベース。",
  openGraph: { type: "website", locale: "ja_JP", siteName: "おかずDB", title: "おかずDB", description: "品番・女優名・メーカー・シリーズ・ジャンルから作品情報を検索", images: [{ url: "/opengraph-image", alt: "おかずDB" }] },
  twitter: { card: "summary_large_image", images: ["/opengraph-image"] },
  alternates: { canonical: "/" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ja"><body className="min-h-screen antialiased"><FunnelSession /><SiteHeader />{children}<SiteFooter /></body></html>;
}
