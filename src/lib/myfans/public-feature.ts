export const MYFANS_PUBLIC_FEATURE_ENV = "MYFANS_PUBLIC_ENABLED" as const;

export function isMyFansPublicEnabled(value = process.env.MYFANS_PUBLIC_ENABLED) {
  return value === "true";
}

export async function loadMyFansPublicWhenEnabled<T>(
  enabled: boolean,
  loader: () => Promise<readonly T[]>,
): Promise<readonly T[]> {
  if (!enabled) return [];
  return loader();
}
