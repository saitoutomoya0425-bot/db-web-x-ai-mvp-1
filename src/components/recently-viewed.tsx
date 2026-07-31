"use client";

import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { HorizontalCarouselShell } from "@/components/horizontal-carousel-shell";
import { PublicWorkCard } from "@/components/public-work-card";
import {
  getLegacyRuntimeThumbnailOverride,
  officialFanzaImageUrl,
} from "@/lib/fanza/media";
import {
  resolveThumbnailPresentation,
  toStoredThumbnailPresentationSnapshot,
  type StoredThumbnailPresentationSnapshot,
} from "@/lib/thumbnail/presentation";

const STORAGE_KEY = "okazu:recently-viewed:v1";
const MAX_ITEMS = 20;
const EVENT_NAME = "okazu:recently-viewed-updated";

export type RecentlyViewedItem = {
  product_code: string;
  title: string;
  card_thumbnail_url?: string | null;
  thumbnail_url: string | null;
  actress_name: string | null;
  maker_name: string | null;
  thumbnail_resolution?: StoredThumbnailPresentationSnapshot | null;
  viewed_at: string;
};

function storedSnapshot(value: unknown): StoredThumbnailPresentationSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (
    source.resolution_kind !== "CANONICAL" &&
    source.resolution_kind !== "LEGACY_COMPAT" &&
    source.resolution_kind !== "NON_RENDERABLE"
  ) {
    return null;
  }
  const resolvedUrl =
    source.resolved_url === null ? null : officialFanzaImageUrl(source.resolved_url);
  if (source.resolved_url !== null && !resolvedUrl) return null;
  return {
    resolution_kind: source.resolution_kind,
    canonical_code:
      typeof source.canonical_code === "string" ? source.canonical_code : null,
    mode: typeof source.mode === "string"
      ? source.mode as StoredThumbnailPresentationSnapshot["mode"]
      : null,
    source_id: typeof source.source_id === "string" ? source.source_id : null,
    approval_status:
      typeof source.approval_status === "string" ? source.approval_status : null,
    render_status:
      typeof source.render_status === "string" ? source.render_status : null,
    resolved_url: resolvedUrl,
  };
}

function readItems() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item): RecentlyViewedItem | null => {
        if (!item || typeof item !== "object") return null;
        const source = item as Record<string, unknown>;
        const productCode = typeof source.product_code === "string" ? source.product_code.slice(0, 80) : "";
        const title = typeof source.title === "string" ? source.title.slice(0, 180) : "";
        if (!productCode || !title) return null;
        return {
          product_code: productCode,
          title,
          card_thumbnail_url: officialFanzaImageUrl(source.card_thumbnail_url),
          thumbnail_url: officialFanzaImageUrl(source.thumbnail_url),
          actress_name: typeof source.actress_name === "string" ? source.actress_name.slice(0, 120) : null,
          maker_name: typeof source.maker_name === "string" ? source.maker_name.slice(0, 120) : null,
          thumbnail_resolution: storedSnapshot(source.thumbnail_resolution),
          viewed_at: typeof source.viewed_at === "string" ? source.viewed_at : new Date(0).toISOString(),
        };
      })
      .filter((item): item is RecentlyViewedItem => item !== null)
      .slice(0, MAX_ITEMS);
  } catch {
    return [];
  }
}

function writeItems(items: RecentlyViewedItem[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, MAX_ITEMS)));
    window.dispatchEvent(new Event(EVENT_NAME));
  } catch {
    // localStorage unavailable: do nothing.
  }
}

function needsCardThumbnailRefresh(item: RecentlyViewedItem) {
  if (!item.thumbnail_resolution) return true;
  const current = toStoredThumbnailPresentationSnapshot(
    resolveThumbnailPresentation({
      code: item.product_code,
      legacy_runtime_override: getLegacyRuntimeThumbnailOverride(item.product_code),
      legacy_card_url: item.card_thumbnail_url,
      legacy_thumbnail_url: item.thumbnail_url,
    }),
  );
  if (JSON.stringify(current) !== JSON.stringify(item.thumbnail_resolution)) {
    return true;
  }
  if (!item.maker_name) return true;
  return false;
}

export function RecentlyViewedRecorder({ item }: { item: Omit<RecentlyViewedItem, "viewed_at"> }) {
  const key = `${item.product_code}:${item.title}`;
  useEffect(() => {
    const cardThumbnailUrl = officialFanzaImageUrl(item.card_thumbnail_url);
    const thumbnailUrl = officialFanzaImageUrl(item.thumbnail_url);
    const thumbnailResolution = toStoredThumbnailPresentationSnapshot(
      resolveThumbnailPresentation({
        code: item.product_code,
        legacy_runtime_override: getLegacyRuntimeThumbnailOverride(item.product_code),
        legacy_card_url: cardThumbnailUrl,
        legacy_thumbnail_url: thumbnailUrl,
      }),
    );
    const nextItem: RecentlyViewedItem = {
      product_code: item.product_code,
      title: item.title,
      thumbnail_url: thumbnailUrl,
      card_thumbnail_url: cardThumbnailUrl,
      actress_name: item.actress_name || null,
      maker_name: item.maker_name || null,
      thumbnail_resolution: thumbnailResolution,
      viewed_at: new Date().toISOString(),
    };
    const current = readItems().filter((saved) => saved.product_code !== nextItem.product_code);
    writeItems([nextItem, ...current]);
  }, [key, item.product_code, item.title, item.card_thumbnail_url, item.thumbnail_url, item.actress_name, item.maker_name]);
  return null;
}

export function RecentlyViewedCarousel({ className = "" }: { className?: string }) {
  const [items, setItems] = useState<RecentlyViewedItem[]>([]);

  useEffect(() => {
    const refresh = () => setItems(readItems());
    refresh();
    window.addEventListener("storage", refresh);
    window.addEventListener(EVENT_NAME, refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener(EVENT_NAME, refresh);
    };
  }, []);

  useEffect(() => {
    const missing = items.filter((item) => needsCardThumbnailRefresh(item)).slice(0, 8);
    if (!missing.length) return;
    let cancelled = false;
    void Promise.all(missing.map(async (item) => {
      try {
        const response = await fetch(`/api/work/${encodeURIComponent(item.product_code)}?recent=1`, { cache: "no-store" });
        if (!response.ok) return null;
        const payload = await response.json() as { data?: { product_code?: string; card_thumbnail_url?: string | null; thumbnail_url?: string | null; makers?: { name?: string | null } | null } };
        const card = officialFanzaImageUrl(payload.data?.card_thumbnail_url);
        const thumbnail = officialFanzaImageUrl(payload.data?.thumbnail_url);
        const resolution = toStoredThumbnailPresentationSnapshot(
          resolveThumbnailPresentation({
            code: payload.data?.product_code ?? item.product_code,
            legacy_runtime_override: getLegacyRuntimeThumbnailOverride(
              payload.data?.product_code ?? item.product_code,
            ),
            legacy_card_url: card,
            legacy_thumbnail_url: thumbnail,
          }),
        );
        return {
          product_code: item.product_code,
          card_thumbnail_url: card,
          thumbnail_url: thumbnail,
          maker_name: payload.data?.makers?.name ?? null,
          thumbnail_resolution: resolution,
        };
      } catch {
        return null;
      }
    })).then((results) => {
      if (cancelled) return;
      const updates = new Map(results.filter((item): item is {
        product_code: string;
        card_thumbnail_url: string | null;
        thumbnail_url: string | null;
        maker_name: string | null;
        thumbnail_resolution: StoredThumbnailPresentationSnapshot;
      } => Boolean(item)).map((item) => [item.product_code, item]));
      if (!updates.size) return;
      const next = readItems().map((item) => {
        const update = updates.get(item.product_code);
        return update ? {
          ...item,
          card_thumbnail_url: update.card_thumbnail_url,
          thumbnail_url: update.thumbnail_url,
          maker_name: update.maker_name ?? item.maker_name,
          thumbnail_resolution: update.thumbnail_resolution,
        } : item;
      });
      writeItems(next);
      setItems(next);
    });
    return () => {
      cancelled = true;
    };
  }, [items]);

  const safeItems = useMemo(
    () => items.map((item) => {
      const hasValidatedSnapshot = Boolean(item.thumbnail_resolution);
      return {
        ...item,
        card_thumbnail_url: hasValidatedSnapshot
          ? officialFanzaImageUrl(item.card_thumbnail_url)
          : null,
        thumbnail_url: hasValidatedSnapshot
          ? officialFanzaImageUrl(item.thumbnail_url)
          : null,
        maker_name: item.maker_name,
      };
    }).slice(0, MAX_ITEMS),
    [items],
  );

  if (!safeItems.length) return null;

  return (
    <HorizontalCarouselShell
      id="recently-viewed"
      eyebrow="最近"
      title="最近閲覧した作品"
      action={<button type="button" onClick={() => writeItems([])} className="inline-flex h-9 items-center gap-1 rounded-full px-2.5 text-xs text-slate-500 transition hover:bg-white/[0.05] hover:text-slate-300" aria-label="閲覧履歴をクリア"><X className="size-3.5" />クリア</button>}
      className={className}
    >
      {safeItems.map((item) => (
        <div key={item.product_code} className="w-[166px] shrink-0 snap-start sm:w-[216px] lg:w-[233px]">
          <PublicWorkCard
            compact
            work={{
              product_code: item.product_code,
              title: item.title,
              card_thumbnail_url: item.card_thumbnail_url,
              thumbnail_url: item.thumbnail_url,
              actresses: item.actress_name ? { id: item.actress_name, name: item.actress_name, name_kana: null, profile_url: null } : null,
              makers: item.maker_name ? { id: item.maker_name, name: item.maker_name, official_url: null } : null,
            }}
          />
        </div>
      ))}
    </HorizontalCarouselShell>
  );
}
