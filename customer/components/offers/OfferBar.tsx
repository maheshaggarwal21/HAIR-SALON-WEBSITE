"use client";

/**
 * Offer bar (DS §5 CampaignBar, CF D29): a thin, colourful strip above the
 * header on every page while an offer runs. It deliberately breaks from the
 * cream palette (globals.css `.offer-*`) so it catches the eye.
 *
 * The prerendered page picks the offer using the API's IST date; after mount
 * the browser re-checks with its own clock, so a cached page never shows an
 * offer that has ended, and switches on one that started at midnight.
 * The real end date is shown; nothing counts down unless it is real.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import type { PublicCampaign } from "@/lib/types";
import { shortDate, todayIST } from "@/lib/format";
import { isInternal, liveOffer } from "./live";

export function OfferBar({ data }: { data: { today: string; campaigns: PublicCampaign[] } | null }) {
  const [today, setToday] = useState(data?.today ?? "");
  useEffect(() => {
    const id = requestAnimationFrame(() => setToday(todayIST()));
    return () => cancelAnimationFrame(id);
  }, []);

  const offer = liveOffer(data?.campaigns, today, "bar");
  if (!offer) return null;
  const { content } = offer;
  const inner = (
    <div className="relative z-[1] mx-auto flex max-w-site items-center justify-center gap-3 md:justify-between">
      <span className="flex min-w-0 items-center gap-3">
        <span aria-hidden className="offer-dot h-2 w-2 shrink-0 rounded-full" />
        {content.eyebrow && (
          <span className="offer-blink shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-[0.14em]">
            {content.eyebrow}
          </span>
        )}
        <span className="truncate text-[14px] font-semibold">{content.headline}</span>
      </span>
      <span className="hidden shrink-0 text-[14px] font-semibold md:inline">
        <span className="font-normal opacity-80">Till {shortDate(offer.endDate)} · </span>
        {content.ctaLabel} →
      </span>
      <span aria-hidden className="shrink-0 text-[14px] font-semibold md:hidden">
        →
      </span>
    </div>
  );
  const cls = `offer-theme-${offer.theme} offer-surface block px-4 py-2.5 md:px-16`;
  return isInternal(content.ctaHref) ? (
    <Link href={content.ctaHref} className={cls}>
      {inner}
    </Link>
  ) : (
    <a href={content.ctaHref} className={cls} target="_blank" rel="noopener">
      {inner}
    </a>
  );
}
