import { ExternalLink, ImageOff } from "lucide-react";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { myFansMediaTypeLabel, type MyFansPublicWork } from "@/lib/myfans/public-ui";

function priceLabel(priceJpy: number | null) {
  return priceJpy === null ? null : new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: 0,
  }).format(priceJpy);
}

export function MyFansPublicWorkDetail({ work }: { work: MyFansPublicWork }) {
  const price = priceLabel(work.priceJpy);
  const mediaType = myFansMediaTypeLabel(work.mediaType);
  return (
    <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10" data-source="myfans">
      <Breadcrumbs items={[{ name: "トップ", href: "/" }, { name: "MyFans" }, { name: work.title }]} />
      <article className="mt-5 grid gap-7 lg:grid-cols-[minmax(0,1.45fr)_minmax(320px,.8fr)] lg:gap-10">
        <div className="grid min-h-[420px] place-items-center rounded-[30px] border border-white/10 bg-slate-950/80 px-6 text-center text-slate-500">
          <div>
            <ImageOff aria-hidden="true" className="mx-auto size-16" />
            <p className="mt-4 text-sm">{work.placeholder.label}</p>
          </div>
        </div>
        <aside>
          <span className="inline-flex rounded-full border border-violet-400/20 bg-violet-400/10 px-3 py-1.5 text-xs font-bold tracking-[0.12em] text-violet-200">{work.sourceBadge}</span>
          <h1 className="mt-4 text-2xl font-black leading-tight tracking-tight sm:text-3xl">{work.title}</h1>
          <dl className="mt-6 divide-y divide-white/5 rounded-2xl border border-white/10 bg-white/[0.035] px-4">
            <div className="grid grid-cols-[96px_1fr] gap-3 py-4"><dt className="text-sm text-slate-500">クリエイター</dt><dd className="text-sm font-medium text-slate-200">{work.creatorName}</dd></div>
            {price && <div className="grid grid-cols-[96px_1fr] gap-3 py-4"><dt className="text-sm text-slate-500">価格</dt><dd className="text-sm font-medium text-slate-200">{price}</dd></div>}
            {mediaType && <div className="grid grid-cols-[96px_1fr] gap-3 py-4"><dt className="text-sm text-slate-500">形式</dt><dd className="text-sm font-medium text-slate-200">{mediaType}</dd></div>}
          </dl>
          <div className="mt-5 grid gap-3">
            <a href={work.canonicalOutboundUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-violet-400/30 bg-violet-500/10 px-4 font-bold text-violet-100 transition hover:bg-violet-500/20">
              <ExternalLink className="size-5" />{work.canonicalCtaLabel}
            </a>
            {work.showAffiliateCta && work.affiliateUrl && (
              <a href={work.affiliateUrl} target="_blank" rel="sponsored noreferrer" className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 px-4 font-bold text-white">
                <ExternalLink className="size-5" />アフィリエイトリンクで本編を見る
              </a>
            )}
          </div>
        </aside>
      </article>
    </main>
  );
}
