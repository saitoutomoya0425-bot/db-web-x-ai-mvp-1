import type { SourceNeutralPrivatePreviewItem } from "@/lib/myfans/private-preview";

function priceLabel(priceJpy: number | null) {
  return priceJpy === null ? null : new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: 0,
  }).format(priceJpy);
}

export function SourceNeutralPrivatePreviewCard({
  item,
}: {
  item: SourceNeutralPrivatePreviewItem;
}) {
  const price = priceLabel(item.priceJpy);
  return (
    <article data-private-preview="true" className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.035]">
      <div className="grid aspect-[7/10] place-items-center bg-slate-950/80 px-4 text-center text-slate-500">
        <div>
          <span aria-hidden="true" className="text-2xl">□</span>
          <p className="mt-2 text-xs">{item.placeholder.label}</p>
        </div>
      </div>
      <div className="space-y-2 p-4">
        <span className="inline-flex rounded-full border border-violet-400/20 bg-violet-400/10 px-2 py-1 text-[10px] font-bold text-violet-200">
          {item.sourceBadge}
        </span>
        <h3 className="text-sm font-semibold leading-6 text-slate-100">{item.title}</h3>
        <p className="text-xs text-slate-400">{item.creator}</p>
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>{item.mediaType}</span>
          {price && <span>{price}</span>}
        </div>
        {item.canonicalOutboundUrl && (
          <a href={item.canonicalOutboundUrl} target="_blank" rel="noreferrer" className="block text-xs text-violet-300 underline-offset-4 hover:underline">
            MyFansの作品ページ
          </a>
        )}
        {item.showAffiliateCta && item.affiliateUrl && (
          <a href={item.affiliateUrl} target="_blank" rel="sponsored noreferrer" className="block rounded-xl bg-violet-600 px-3 py-2 text-center text-sm font-bold text-white">
            本編を見る
          </a>
        )}
        {!item.publicationEligibility && (
          <p className="text-[11px] text-amber-300">Private preview: {item.blockReasons.join(", ")}</p>
        )}
      </div>
    </article>
  );
}
