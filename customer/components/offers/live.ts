/**
 * Which offer is live on a given IST date (CF D29). Dates are inclusive
 * `YYYY-MM-DD` strings, so plain string comparison is correct.
 */

import type { PublicCampaign } from "@/lib/types";

export function liveOffer(list: PublicCampaign[] | null | undefined, today: string, place: "bar" | "popup") {
  return (list ?? []).find(
    (c) => c.startDate <= today && today <= c.endDate && (place === "bar" ? c.showBar : c.showPopup)
  );
}

/** Internal pages use client navigation; anything else is a normal link. */
export const isInternal = (href: string) => href.startsWith("/") && !href.startsWith("//");
