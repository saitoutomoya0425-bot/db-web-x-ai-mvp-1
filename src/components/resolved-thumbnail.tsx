"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Image from "next/image";
import { ImageIcon } from "lucide-react";
import { buildThumbnailRenderContract } from "@/lib/thumbnail/presentation";
import {
  resolveEffectiveThumbnailRender,
  type ThumbnailRenderDimensions,
} from "@/lib/thumbnail/render-policy";
import type { ThumbnailPresentationResolution } from "@/lib/thumbnail/types";

export function ResolvedThumbnail({
  resolution,
  alt,
  sizes,
  priority = false,
  className = "",
  imageClassName = "",
  placeholderClassName = "",
  placeholder,
  children,
}: {
  resolution: ThumbnailPresentationResolution;
  alt: string;
  sizes: string;
  priority?: boolean;
  className?: string;
  imageClassName?: string;
  placeholderClassName?: string;
  placeholder?: ReactNode;
  children?: ReactNode;
}) {
  const contract = useMemo(
    () => buildThumbnailRenderContract(resolution),
    [resolution],
  );
  const [failed, setFailed] = useState(false);
  const [dimensions, setDimensions] =
    useState<ThumbnailRenderDimensions | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    setFailed(false);
    setDimensions(null);
  }, [contract.src]);

  const showImage = Boolean(contract.src && !failed);
  const effectiveRender = useMemo(
    () =>
      contract.object_fit &&
      contract.object_position &&
      contract.upscale_policy &&
      contract.fallback_when_upscale_required
        ? resolveEffectiveThumbnailRender({
            requested_fit: contract.object_fit,
            requested_position: contract.object_position,
            upscale_policy: contract.upscale_policy,
            fallback_when_upscale_required:
              contract.fallback_when_upscale_required,
            dimensions,
          })
        : null,
    [contract, dimensions],
  );
  const measure = useCallback(() => {
    const image = imageRef.current;
    const container = containerRef.current;
    if (!image || !container || !image.naturalWidth || !image.naturalHeight) {
      return;
    }
    const bounds = container.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const next = {
      natural_width: image.naturalWidth,
      natural_height: image.naturalHeight,
      container_width: bounds.width,
      container_height: bounds.height,
    };
    setDimensions((current) =>
      current &&
      current.natural_width === next.natural_width &&
      current.natural_height === next.natural_height &&
      current.container_width === next.container_width &&
      current.container_height === next.container_height
        ? current
        : next,
    );
  }, []);

  useEffect(() => {
    if (!showImage) return;
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [measure, showImage]);

  const effectiveFit = effectiveRender?.effective_fit ?? "scale-down";
  const fitClass =
    effectiveFit === "cover"
      ? "object-cover"
      : effectiveFit === "scale-down"
        ? "object-scale-down"
        : "object-contain";

  return (
    <div
      ref={containerRef}
      className={className}
      data-thumbnail-code={contract.attributes.code ?? undefined}
      data-thumbnail-resolution-kind={contract.attributes.resolution_kind}
      data-thumbnail-mode={contract.attributes.mode ?? undefined}
      data-thumbnail-source-id={contract.attributes.source_id ?? undefined}
      data-thumbnail-approval-status={contract.attributes.approval_status ?? undefined}
      data-thumbnail-render-status={contract.attributes.render_status ?? undefined}
      data-thumbnail-crop-intent={contract.crop_intent ?? undefined}
      data-thumbnail-requested-fit={contract.object_fit ?? undefined}
      data-thumbnail-effective-fit={effectiveRender?.effective_fit ?? undefined}
      data-thumbnail-requested-position={contract.object_position ?? undefined}
      data-thumbnail-effective-position={effectiveRender?.effective_position ?? undefined}
      data-thumbnail-upscale-policy={contract.upscale_policy ?? undefined}
      data-thumbnail-upscale-fallback={
        contract.fallback_when_upscale_required ?? undefined
      }
      data-thumbnail-upscale-required={
        effectiveRender ? String(effectiveRender.upscale_required) : undefined
      }
      data-thumbnail-fallback-applied={
        effectiveRender ? String(effectiveRender.fallback_applied) : undefined
      }
      data-thumbnail-estimated-scale={
        effectiveRender?.effective_scale === null ||
        effectiveRender?.effective_scale === undefined
          ? undefined
          : effectiveRender.effective_scale.toFixed(6)
      }
      data-thumbnail-natural-width={dimensions?.natural_width}
      data-thumbnail-natural-height={dimensions?.natural_height}
      data-thumbnail-container-width={dimensions?.container_width}
      data-thumbnail-container-height={dimensions?.container_height}
      data-thumbnail-crop-spec={
        contract.crop_spec ? JSON.stringify(contract.crop_spec) : undefined
      }
    >
      {showImage ? (
        <Image
          ref={imageRef}
          src={contract.src!}
          alt={alt}
          fill
          priority={priority}
          unoptimized
          sizes={sizes}
          onLoad={() => measure()}
          onError={() => {
            setDimensions(null);
            setFailed(true);
          }}
          style={{
            objectPosition: effectiveRender?.effective_position ?? "center",
          }}
          className={`${fitClass} ${imageClassName}`}
        />
      ) : (
        placeholder ?? (
          <div
            className={`grid h-full place-items-center bg-slate-950/80 px-4 text-center text-slate-600 ${placeholderClassName}`}
          >
            <div>
              <ImageIcon className="mx-auto mb-3 size-8" />
              <p className="font-mono text-[11px] font-semibold tracking-[0.22em]">
                NOW
                <br />
                PRINTING
              </p>
            </div>
          </div>
        )
      )}
      {children}
    </div>
  );
}
