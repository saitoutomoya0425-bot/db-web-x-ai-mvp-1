import thumbnailLocalOverrides from "../../../data/thumbnail-local-overrides.json" with {
  type: "json",
};
import { canonicalizeProductCodeValue } from "./normalize.ts";
import { isTrustedThumbnailOutput } from "../thumbnail/contract.ts";
import type { LegacyRuntimeThumbnailOverride } from "../thumbnail/types.ts";

const CARD_THUMBNAIL_OVERRIDES = thumbnailLocalOverrides as Record<string, {
  path: string;
  mode: string;
  sourceId: string;
  sha256: string;
}>;

export function officialFanzaImageUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  return isTrustedThumbnailOutput(trimmed) ? trimmed : null;
}

export function getLegacyRuntimeThumbnailOverride(
  productCode: unknown,
): LegacyRuntimeThumbnailOverride | null {
  const normalized = canonicalizeProductCodeValue(productCode);
  if (!normalized.canonical || normalized.rejected) return null;
  const override = CARD_THUMBNAIL_OVERRIDES[normalized.canonical];
  if (!override) return null;
  return {
    path: override.path,
    mode: override.mode,
    source_id: override.sourceId,
    output_hash: override.sha256,
  };
}
