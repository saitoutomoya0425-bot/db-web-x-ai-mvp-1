import {
  decideMyFansPublication,
  type MyFansAffiliateLinkStatus,
  type MyFansPublicationCandidate,
  type MyFansPublicationDecision,
} from "./publication.ts";

export type MyFansPrivatePreviewSource = MyFansPublicationCandidate & {
  creatorDisplayName: string;
  priceJpy: number | null;
  mediaType: "text" | "image" | "video" | "mixed" | "unknown";
};

export type SourceNeutralPrivatePreviewItem = {
  sourceBadge: "MyFans";
  title: string;
  creator: string;
  priceJpy: number | null;
  mediaType: MyFansPrivatePreviewSource["mediaType"];
  placeholder: {
    kind: "local_neutral";
    label: "画像は掲載していません";
  };
  canonicalOutboundUrl: string | null;
  affiliateLinkStatus: MyFansAffiliateLinkStatus;
  affiliateUrl: string | null;
  showAffiliateCta: boolean;
  publicationEligibility: boolean;
  blockReasons: MyFansPublicationDecision["blockReasons"];
};

export function toMyFansPrivatePreview(
  source: MyFansPrivatePreviewSource,
): SourceNeutralPrivatePreviewItem {
  const decision = decideMyFansPublication(source);
  return {
    sourceBadge: "MyFans",
    title: source.title?.trim() ?? "",
    creator: source.creatorDisplayName.trim(),
    priceJpy: source.priceJpy,
    mediaType: source.mediaType,
    placeholder: {
      kind: "local_neutral",
      label: "画像は掲載していません",
    },
    canonicalOutboundUrl: decision.canonicalOutboundUrl,
    affiliateLinkStatus: source.affiliateLinkStatus,
    affiliateUrl: decision.affiliateCta.url,
    showAffiliateCta: decision.affiliateCta.show,
    publicationEligibility: decision.eligible,
    blockReasons: decision.blockReasons,
  };
}

export function summarizeMyFansPrivatePreview(items: readonly SourceNeutralPrivatePreviewItem[]) {
  return {
    total: items.length,
    eligible: items.filter((item) => item.publicationEligibility).length,
    blocked: items.filter((item) => !item.publicationEligibility).length,
    affiliateCtaVisible: items.filter((item) => item.showAffiliateCta).length,
    neutralPlaceholders: items.filter((item) => item.placeholder.kind === "local_neutral").length,
  };
}
