"use client";

import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { HorizontalCarouselShell } from "@/components/horizontal-carousel-shell";
import { PublicWorkCard } from "@/components/public-work-card";
import { officialFanzaImageUrl } from "@/lib/fanza/media";

const STORAGE_KEY = "okazu:recently-viewed:v1";
const MAX_ITEMS = 20;
const EVENT_NAME = "okazu:recently-viewed-updated";
const CARD_THUMBNAIL_OVERRIDES: Record<string, string> = {
  RBB00339: "/card-thumbnails/RBB00339-right.jpg",
  "1SBP00426": "/card-thumbnails/1SBP00426-rotated.jpg",
  "1SBP00427": "/card-thumbnails/1SBP00427-rotated.jpg",
  "1SBP00428": "/card-thumbnails/1SBP00428-rotated.jpg",
};

export type RecentlyViewedItem = {
  product_code: string;
  title: string;
  card_thumbnail_url?: string | null;
  thumbnail_url: string | null;
  actress_name: string | null;
  maker_name: string | null;
  viewed_at: string;
};

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
          card_thumbnail_url: typeof source.card_thumbnail_url === "string" ? source.card_thumbnail_url : null,
          thumbnail_url: typeof source.thumbnail_url === "string" ? source.thumbnail_url : null,
          actress_name: typeof source.actress_name === "string" ? source.actress_name.slice(0, 120) : null,
          maker_name: typeof source.maker_name === "string" ? source.maker_name.slice(0, 120) : null,
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
  const url = item.card_thumbnail_url;
  const safeUrl = officialFanzaImageUrl(url);
  if (!safeUrl) return true;
  if (CARD_THUMBNAIL_OVERRIDES[item.product_code] && safeUrl !== CARD_THUMBNAIL_OVERRIDES[item.product_code]) return true;
  if (!item.maker_name) return true;
  if (safeUrl.startsWith("/card-thumbnails/")) return !/(?:-v\d+|-rotated|-full)\.jpg$/i.test(safeUrl);
  return true;
}

export function RecentlyViewedRecorder({ item }: { item: Omit<RecentlyViewedItem, "viewed_at"> }) {
  const key = `${item.product_code}:${item.title}`;
  useEffect(() => {
    const nextItem: RecentlyViewedItem = {
      product_code: item.product_code,
      title: item.title,
      thumbnail_url: officialFanzaImageUrl(item.thumbnail_url) ?? null,
      card_thumbnail_url: officialFanzaImageUrl(item.card_thumbnail_url) ?? null,
      actress_name: item.actress_name || null,
      maker_name: item.maker_name || null,
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
        if (!card) return null;
        return { product_code: item.product_code, card_thumbnail_url: card, thumbnail_url: officialFanzaImageUrl(payload.data?.thumbnail_url), maker_name: payload.data?.makers?.name ?? null };
      } catch {
        return null;
      }
    })).then((results) => {
      if (cancelled) return;
      const updates = new Map(results.filter((item): item is { product_code: string; card_thumbnail_url: string; thumbnail_url: string | null; maker_name: string | null } => Boolean(item)).map((item) => [item.product_code, item]));
      if (!updates.size) return;
      const next = readItems().map((item) => {
        const update = updates.get(item.product_code);
        return update ? { ...item, card_thumbnail_url: update.card_thumbnail_url, thumbnail_url: update.thumbnail_url ?? item.thumbnail_url, maker_name: update.maker_name ?? item.maker_name } : item;
      });
      writeItems(next);
      setItems(next);
    });
    return () => {
      cancelled = true;
    };
  }, [items]);

  const safeItems = useMemo(
    () => items.map((item) => ({
      ...item,
      card_thumbnail_url: officialFanzaImageUrl(item.card_thumbnail_url),
      thumbnail_url: officialFanzaImageUrl(item.thumbnail_url),
      maker_name: item.maker_name,
    })).slice(0, MAX_ITEMS),
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
