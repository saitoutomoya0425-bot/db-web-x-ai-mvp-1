export type NormalizedFanzaProduct = {
  externalProductId: string;
  originalProductCode: string | null;
  productCode: string | null;
  normalizedProductCode: string | null;
  title: string | null;
  actressNames: string[];
  makerName: string | null;
  seriesName: string | null;
  labelName: string | null;
  genres: string[];
  releaseDate: string | null;
  description: string | null;
  cardThumbnailUrl: string | null;
  thumbnailUrl: string | null;
  sampleImages: string[];
  sampleVideoUrl: string | null;
  officialUrl: string | null;
  affiliateUrl: string | null;
  price: number | null;
  currency: "JPY";
  availabilityStatus: "available";
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
const url = (value: unknown) => {
  const candidate = text(value);
  if (!candidate) return null;
  try { return ["http:", "https:"].includes(new URL(candidate).protocol) ? candidate : null; } catch { return null; }
};
const list = (value: unknown) => Array.isArray(value) ? value : [];
const names = (value: unknown) => list(value).map((item) => text(record(item).name)).filter((item): item is string => Boolean(item));
const firstName = (itemInfo: Record<string, unknown>, key: string) => names(itemInfo[key])[0] ?? null;

export function normalizeProductCodeValue(value: unknown) {
  const original = text(value);
  if (!original) return { original: null, display: null, normalized: null };
  const display = original.toUpperCase().replace(/\s+/g, "");
  const normalized = display.replace(/[^A-Z0-9]/g, "");
  return { original, display, normalized: normalized || null };
}

export function normalizeFanzaItem(input: unknown): NormalizedFanzaProduct {
  const item = record(input);
  const itemInfo = record(item.iteminfo);
  const externalProductId = text(item.content_id) ?? text(item.product_id) ?? "";
  const code = normalizeProductCodeValue(item.product_id ?? item.content_id);
  const image = record(item.imageURL);
  const sampleImage = record(item.sampleImageURL);
  const sampleImages = [
    ...list(record(sampleImage.sample_l).image),
    ...list(record(sampleImage.sample_s).image),
  ].map(url).filter((item): item is string => Boolean(item));
  const movie = record(item.sampleMovieURL);
  const sampleVideoUrl = ["size_720_480", "size_644_414", "size_560_360", "size_476_306"]
    .map((key) => url(movie[key])).find(Boolean) ?? null;
  const date = text(item.date);
  const releaseDate = date && /^\d{4}[-/]\d{2}[-/]\d{2}/.test(date)
    ? date.slice(0, 10).replaceAll("/", "-")
    : null;
  const rawPrice = text(record(item.prices).price);
  const parsedPrice = rawPrice ? Number(rawPrice.replace(/[^\d.]/g, "")) : Number.NaN;
  return {
    externalProductId,
    originalProductCode: code.original,
    productCode: code.display,
    normalizedProductCode: code.normalized,
    title: text(item.title),
    actressNames: names(itemInfo.actress),
    makerName: firstName(itemInfo, "maker"),
    seriesName: firstName(itemInfo, "series"),
    labelName: firstName(itemInfo, "label"),
    genres: [...new Set(names(itemInfo.genre))],
    releaseDate,
    description: text(item.description) ?? text(item.comment),
    cardThumbnailUrl: url(image.large) ?? url(image.small) ?? url(image.list),
    thumbnailUrl: url(image.large) ?? url(image.list) ?? url(image.small),
    sampleImages: [...new Set(sampleImages)],
    sampleVideoUrl,
    officialUrl: url(item.URL) ?? url(item.URLsp),
    affiliateUrl: url(item.affiliateURL) ?? url(item.affiliateURLsp),
    price: Number.isFinite(parsedPrice) ? parsedPrice : null,
    currency: "JPY",
    availabilityStatus: "available",
  };
}
