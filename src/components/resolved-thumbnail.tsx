"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Image from "next/image";
import { ImageIcon } from "lucide-react";
import { buildThumbnailRenderContract } from "@/lib/thumbnail/presentation";
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

  useEffect(() => {
    setFailed(false);
  }, [contract.src]);

  const showImage = Boolean(contract.src && !failed);
  const fitClass =
    contract.object_fit === "cover" ? "object-cover" : "object-contain";

  return (
    <div
      className={className}
      data-thumbnail-code={contract.attributes.code ?? undefined}
      data-thumbnail-resolution-kind={contract.attributes.resolution_kind}
      data-thumbnail-mode={contract.attributes.mode ?? undefined}
      data-thumbnail-source-id={contract.attributes.source_id ?? undefined}
      data-thumbnail-approval-status={contract.attributes.approval_status ?? undefined}
      data-thumbnail-render-status={contract.attributes.render_status ?? undefined}
      data-thumbnail-crop-spec={
        contract.crop_spec ? JSON.stringify(contract.crop_spec) : undefined
      }
    >
      {showImage ? (
        <Image
          src={contract.src!}
          alt={alt}
          fill
          priority={priority}
          unoptimized
          sizes={sizes}
          onError={() => setFailed(true)}
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
