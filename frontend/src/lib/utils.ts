/**
 * @file utils.ts
 * @description Shared utility — merges Tailwind CSS class names safely.
 */

import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind classes, resolving conflicts (e.g. `p-2` vs `p-4`). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format a Date as a `YYYY-MM-DD` key in the LOCAL timezone.
 *
 * Do not use `toISOString().slice(0, 10)` for this. That converts to UTC first,
 * so in any timezone ahead of UTC a local midnight rolls back a day:
 *
 *   new Date(2026, 7, 1)  →  1 Aug 2026 00:00 IST
 *     .toISOString()      →  "2026-07-31T18:30:00.000Z"
 *     .slice(0, 10)       →  "2026-07-31"   ← one day early
 *
 * Date-range presets are built from local midnight, so every `from` date came
 * out a day early and each range silently included an extra day of visits.
 */
export function toLocalDateKey(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
