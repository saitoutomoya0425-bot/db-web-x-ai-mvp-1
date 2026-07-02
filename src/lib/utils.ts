import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(value: string | null) {
  if (!value) return "未設定";
  return new Intl.DateTimeFormat("ja-JP").format(new Date(`${value}T00:00:00`));
}
