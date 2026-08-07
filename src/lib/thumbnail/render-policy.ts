import type {
  ThumbnailObjectFit,
  ThumbnailObjectPosition,
  ThumbnailUpscaleFallback,
  ThumbnailUpscalePolicy,
} from "./types.ts";

export const THUMBNAIL_UPSCALE_EPSILON = 0.001;

export type ThumbnailRenderDimensions = {
  readonly natural_width: number;
  readonly natural_height: number;
  readonly container_width: number;
  readonly container_height: number;
};

export type EffectiveThumbnailRender = {
  readonly image_dimensions_ready: boolean;
  readonly requested_fit: ThumbnailObjectFit;
  readonly requested_position: ThumbnailObjectPosition;
  readonly effective_fit: ThumbnailObjectFit;
  readonly effective_position: ThumbnailObjectPosition;
  readonly requested_scale: number | null;
  readonly effective_scale: number | null;
  readonly upscale_required: boolean;
  readonly fallback_applied: boolean;
  readonly reason: "IMAGE_DIMENSIONS_PENDING" | "REQUESTED_FIT_SAFE" | "UPSCALE_DENIED";
};

function validDimension(value: number) {
  return Number.isFinite(value) && value > 0;
}

/**
 * Resolves the browser-facing fit without changing the selected image.
 * Unknown dimensions always start from the safe fallback so SSR and the first
 * hydrated frame cannot enlarge or crop an image before it has loaded.
 */
export function resolveEffectiveThumbnailRender(input: {
  readonly requested_fit: ThumbnailObjectFit;
  readonly requested_position: ThumbnailObjectPosition;
  readonly upscale_policy: ThumbnailUpscalePolicy;
  readonly fallback_when_upscale_required: ThumbnailUpscaleFallback;
  readonly dimensions: ThumbnailRenderDimensions | null;
}): EffectiveThumbnailRender {
  const {
    requested_fit,
    requested_position,
    upscale_policy,
    fallback_when_upscale_required,
    dimensions,
  } = input;

  if (
    upscale_policy !== "DENY" ||
    fallback_when_upscale_required !== "scale-down"
  ) {
    throw new TypeError("unsupported thumbnail upscale policy");
  }

  if (
    !dimensions ||
    !validDimension(dimensions.natural_width) ||
    !validDimension(dimensions.natural_height) ||
    !validDimension(dimensions.container_width) ||
    !validDimension(dimensions.container_height)
  ) {
    return {
      image_dimensions_ready: false,
      requested_fit,
      requested_position,
      effective_fit: fallback_when_upscale_required,
      effective_position: "center",
      requested_scale: null,
      effective_scale: null,
      upscale_required: false,
      fallback_applied: requested_fit !== fallback_when_upscale_required,
      reason: "IMAGE_DIMENSIONS_PENDING",
    };
  }

  const containScale = Math.min(
    dimensions.container_width / dimensions.natural_width,
    dimensions.container_height / dimensions.natural_height,
  );
  const requestedScale =
    requested_fit === "cover"
      ? Math.max(
          dimensions.container_width / dimensions.natural_width,
          dimensions.container_height / dimensions.natural_height,
        )
      : requested_fit === "contain"
        ? containScale
        : Math.min(1, containScale);
  const upscaleRequired = requestedScale > 1 + THUMBNAIL_UPSCALE_EPSILON;

  if (upscaleRequired) {
    return {
      image_dimensions_ready: true,
      requested_fit,
      requested_position,
      effective_fit: fallback_when_upscale_required,
      effective_position: "center",
      requested_scale: requestedScale,
      effective_scale: Math.min(1, containScale),
      upscale_required: true,
      fallback_applied: true,
      reason: "UPSCALE_DENIED",
    };
  }

  return {
    image_dimensions_ready: true,
    requested_fit,
    requested_position,
    effective_fit: requested_fit,
    effective_position:
      requested_fit === "scale-down" ? "center" : requested_position,
    requested_scale: requestedScale,
    effective_scale: requestedScale,
    upscale_required: false,
    fallback_applied: false,
    reason: "REQUESTED_FIT_SAFE",
  };
}
