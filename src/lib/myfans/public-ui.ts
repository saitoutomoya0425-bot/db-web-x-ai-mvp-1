import {
  decideMyFansAffiliateCta,
  isCanonicalMyFansPostUrl,
  type MyFansAffiliateLinkStatus,
} from "./publication.ts";
import type { MyFansApprovedPublicationProjection } from "@/types/database";

export type MyFansPublicMediaType = "text" | "image" | "video" | "mixed" | "unknown";

export type MyFansPublicWork = {
  source: "myfans";
  sourceBadge: "MyFans";
  stableIdentity: string;
  externalPostId: string;
  detailHref: string;
  title: string;
  creatorName: string;
  creatorProfileSlug: string;
  priceJpy: number | null;
  currency: "JPY";
  mediaType: MyFansPublicMediaType;
  canonicalOutboundUrl: string;
  canonicalCtaLabel: "MyFansで作品を見る";
  affiliateLinkStatus: MyFansAffiliateLinkStatus;
  affiliateUrl: string | null;
  showAffiliateCta: boolean;
  placeholder: {
    kind: "local_neutral";
    label: "画像は掲載していません";
  };
};

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEDIA_TYPES = new Set<MyFansPublicMediaType>(["text", "image", "video", "mixed", "unknown"]);
const AFFILIATE_STATUSES = new Set<MyFansAffiliateLinkStatus>(["missing", "active", "ineligible", "revoked"]);

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function price(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function isMyFansPublicPostId(value: string) {
  return UUID_LIKE.test(value);
}

export function myFansPublicDetailHref(externalPostId: string) {
  return isMyFansPublicPostId(externalPostId)
    ? `/work/myfans/${externalPostId.toLowerCase()}`
    : null;
}

export function myFansMediaTypeLabel(mediaType: MyFansPublicMediaType) {
  if (mediaType === "video") return "動画";
  if (mediaType === "image") return "画像";
  if (mediaType === "text") return "テキスト";
  if (mediaType === "mixed") return "複合メディア";
  return null;
}

export function toMyFansPublicWork(
  row: MyFansApprovedPublicationProjection,
): MyFansPublicWork | null {
  const externalPostId = text(row.external_post_id);
  const title = text(row.title);
  const creatorName = text(row.creator_display_name);
  const creatorProfileSlug = text(row.creator_profile_slug);
  const canonicalOutboundUrl = text(row.canonical_outbound_url);
  const detailHref = externalPostId ? myFansPublicDetailHref(externalPostId) : null;
  if (
    row.source_badge !== "MyFans"
    || !externalPostId
    || !title
    || !creatorName
    || !creatorProfileSlug
    || !canonicalOutboundUrl
    || !detailHref
    || !isCanonicalMyFansPostUrl(canonicalOutboundUrl, externalPostId)
    || row.currency !== "JPY"
    || !MEDIA_TYPES.has(row.media_type as MyFansPublicMediaType)
    || !AFFILIATE_STATUSES.has(row.affiliate_link_status as MyFansAffiliateLinkStatus)
  ) return null;

  const affiliateLinkStatus = row.affiliate_link_status as MyFansAffiliateLinkStatus;
  const affiliate = decideMyFansAffiliateCta(affiliateLinkStatus, row.affiliate_url);
  return {
    source: "myfans",
    sourceBadge: "MyFans",
    stableIdentity: `myfans:${externalPostId.toLowerCase()}`,
    externalPostId: externalPostId.toLowerCase(),
    detailHref,
    title,
    creatorName,
    creatorProfileSlug,
    priceJpy: price(row.price),
    currency: "JPY",
    mediaType: row.media_type as MyFansPublicMediaType,
    canonicalOutboundUrl,
    canonicalCtaLabel: "MyFansで作品を見る",
    affiliateLinkStatus,
    affiliateUrl: affiliate.url,
    showAffiliateCta: affiliate.show,
    placeholder: {
      kind: "local_neutral",
      label: "画像は掲載していません",
    },
  };
}

export function toMyFansPublicWorks(rows: readonly MyFansApprovedPublicationProjection[]) {
  return rows.map(toMyFansPublicWork).filter((work): work is MyFansPublicWork => work !== null);
}
