import { canonicalizeProductCodeValue } from "../fanza/normalize.ts";
import { isTrustedThumbnailOutput } from "../thumbnail/contract.ts";

export type CatalogPublicationInput = {
  product_code?: string | null;
  title?: string | null;
  actress_name?: string | null;
  card_thumbnail_url?: string | null;
  thumbnail_url?: string | null;
  official_url?: string | null;
  affiliate_url?: string | null;
  source_name?: string | null;
  external_product_id?: string | null;
};

const hasText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export function isOfficialSalesUrl(value: string | null | undefined) {
  if (!hasText(value)) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:"
      && url.username === ""
      && url.password === ""
      && (url.port === "" || url.port === "443")
      && ["dmm.com", "dmm.co.jp", "fanza.com", "fanza.co.jp"]
        .some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

export function catalogPublicationEligibilityReasons(
  input: CatalogPublicationInput,
  options: {
    hasActressRelation: boolean;
    hasSourceRelation: boolean;
    hasDuplicate: boolean;
  },
) {
  const reasons: string[] = [];
  const code = canonicalizeProductCodeValue(input.product_code);
  if (!code.canonical || !code.canonicalNormalized || code.rejected) {
    reasons.push("normalized_product_code_missing");
  }
  if (!hasText(input.title)) reasons.push("title_missing");
  if (!hasText(input.source_name)) reasons.push("source_provenance_missing");
  if (!hasText(input.external_product_id)) reasons.push("external_product_id_missing");
  if (!isOfficialSalesUrl(input.official_url)) reasons.push("official_url_not_allowed");
  if (!hasText(input.affiliate_url)) reasons.push("affiliate_url_missing");
  else if (!isOfficialSalesUrl(input.affiliate_url)) reasons.push("affiliate_url_not_allowed");

  const imageUrls = [input.card_thumbnail_url, input.thumbnail_url]
    .filter((value): value is string => hasText(value));
  if (!imageUrls.length) reasons.push("image_missing");
  else if (imageUrls.some((value) => !isTrustedThumbnailOutput(value))) {
    reasons.push("image_url_not_allowed");
  }

  if (!hasText(input.actress_name)) reasons.push("actress_metadata_missing");
  if (!options.hasActressRelation) reasons.push("actress_relation_missing");
  if (!options.hasSourceRelation) reasons.push("source_relation_missing");
  if (options.hasDuplicate) reasons.push("duplicate_detected");
  return reasons;
}
