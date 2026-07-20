export const LIST_VIEW_STATE_PREFIX = "okazu:list-view:";

export type ListViewState = {
  visibleCount?: number;
  scrollY?: number;
  selectedCode?: string;
  updatedAt?: number;
};

export function currentListViewKey() {
  if (typeof window === "undefined") return null;
  return `${LIST_VIEW_STATE_PREFIX}${window.location.pathname}${window.location.search}`;
}

export function readListViewState(key: string | null): ListViewState | null {
  if (!key || typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(key) ?? "null") as ListViewState | null;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function writeListViewState(key: string | null, patch: ListViewState) {
  if (!key || typeof window === "undefined") return;
  try {
    const current = readListViewState(key) ?? {};
    window.sessionStorage.setItem(key, JSON.stringify({ ...current, ...patch, updatedAt: Date.now() }));
  } catch {
    // sessionStorage unavailable: do nothing.
  }
}
