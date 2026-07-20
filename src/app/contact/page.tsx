import type { Metadata } from "next";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { ContactForm } from "@/components/contact-form";

export const metadata: Metadata = {
  title: "お問い合わせ",
  description: "おかずDBへのお問い合わせ、掲載情報の修正、権利・削除依頼。",
  alternates: { canonical: "/contact" },
};

export default function ContactPage() {
  return <main className="mx-auto max-w-3xl px-5 py-12">
    <Breadcrumbs items={[{ name: "トップ", href: "/" }, { name: "お問い合わせ" }]} />
    <h1 className="mt-7 text-3xl font-black">お問い合わせ</h1>
    <p className="mt-4 leading-7 text-slate-300">一般のお問い合わせ、掲載情報の修正、著作権・肖像権に関する削除依頼を受け付けています。権利に関するご連絡では、対象ページのURLと確認可能な権利関係をご記載ください。</p>
    <ContactForm />
  </main>;
}
