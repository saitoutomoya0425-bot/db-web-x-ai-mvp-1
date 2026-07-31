import {
  buildThumbnailRenderContract,
} from "./presentation.ts";
import type { ThumbnailPresentationResolution } from "./types.ts";

export type ThumbnailStructuredDataImage = Readonly<{
  thumbnailUrl: readonly [string];
  image: string;
}>;

export function resolvedThumbnailPublicUrl(
  resolution: ThumbnailPresentationResolution,
  siteBaseUrl: string,
): string | null {
  const source = buildThumbnailRenderContract(resolution).src;
  if (!source) return null;
  if (source.startsWith("https://")) return source;
  try {
    const base = new URL(siteBaseUrl);
    if (
      base.protocol !== "https:" ||
      base.username ||
      base.password
    ) {
      return null;
    }
    return new URL(source, base).toString();
  } catch {
    return null;
  }
}

export function thumbnailStructuredDataImage(
  resolution: ThumbnailPresentationResolution,
  siteBaseUrl: string,
): ThumbnailStructuredDataImage | Record<string, never> {
  const image = resolvedThumbnailPublicUrl(resolution, siteBaseUrl);
  return image
    ? { thumbnailUrl: [image], image }
    : {};
}
