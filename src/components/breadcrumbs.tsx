import Link from "next/link";

type Item = { name: string; href?: string };
export function Breadcrumbs({ items }: { items: Item[] }) {
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const json = { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: items.map((item, index) => ({ "@type": "ListItem", position: index + 1, name: item.name, item: item.href ? new URL(item.href, site).toString() : undefined })) };
  return <><script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(json).replace(/</g, "\\u003c") }} /><nav aria-label="パンくず" className="flex flex-wrap items-center gap-2 text-xs text-slate-500">{items.map((item, index) => <span key={`${item.name}-${index}`} className="flex items-center gap-2">{index > 0 && <span>/</span>}{item.href ? <Link href={item.href} className="hover:text-violet-300">{item.name}</Link> : <span aria-current="page">{item.name}</span>}</span>)}</nav></>;
}
