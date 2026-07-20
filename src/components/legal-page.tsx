import { Breadcrumbs } from "@/components/breadcrumbs";

export function LegalPage({ title, lead, children }: { title: string; lead: string; children: React.ReactNode }) {
  return <main className="mx-auto max-w-3xl px-5 py-12">
    <Breadcrumbs items={[{ name: "トップ", href: "/" }, { name: title }]} />
    <h1 className="mt-7 text-3xl font-black">{title}</h1>
    <p className="mt-4 leading-7 text-slate-300">{lead}</p>
    <div className="mt-10 space-y-9 text-sm leading-7 text-slate-300">{children}</div>
  </main>;
}
