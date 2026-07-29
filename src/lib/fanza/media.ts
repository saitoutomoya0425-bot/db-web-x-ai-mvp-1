import thumbnailLocalOverrides from "../../../data/thumbnail-local-overrides.json";

const IMAGE_HOSTS = new Set(["pics.dmm.co.jp"]);
const LOCAL_CARD_THUMBNAIL_PREFIX = "/card-thumbnails/";
const CARD_THUMBNAIL_OVERRIDES = thumbnailLocalOverrides as Record<string, {
  path: string;
  mode: string;
  sourceId: string;
  sha256: string;
}>;

export function officialFanzaImageUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  if (trimmed.startsWith(LOCAL_CARD_THUMBNAIL_PREFIX) && !trimmed.includes("..")) return trimmed;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" && IMAGE_HOSTS.has(url.hostname.toLowerCase())
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function resolvedCardThumbnailUrl(productCode: unknown, value: unknown) {
  const code = typeof productCode === "string" ? productCode.trim() : "";
  const override = CARD_THUMBNAIL_OVERRIDES[code];
  return officialFanzaImageUrl(override?.path ?? value);
}
