"use client";

/**
 * Offer pop-up (DS §5 Popup, CF D29): a small poster card for the live offer.
 *
 * Rules from DESIGN.md, kept on purpose:
 *   - never in the first 5 seconds (the owner's delay is 5–60s);
 *   - at most once per visit, or once per day if the owner chose that;
 *   - a 44px close button, Escape and the backdrop all close it;
 *   - not on the offer's own page, and never on top of the request sheet;
 *   - reduced motion: appears without animating.
 * Browser storage only remembers "already shown"; if it's unavailable the
 * pop-up still shows at most once per page load.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { PublicCampaign } from "@/lib/types";
import { shortDate, todayIST } from "@/lib/format";
import { useRequest } from "@/components/request/RequestContext";
import { isInternal, liveOffer } from "./live";

const seenKey = (id: string) => `offer-popup:${id}`;

function alreadySeen(c: PublicCampaign, today: string) {
  try {
    return c.popup.frequency === "session"
      ? sessionStorage.getItem(seenKey(c.id)) === "1"
      : localStorage.getItem(seenKey(c.id)) === today;
  } catch {
    return false;
  }
}

function markSeen(c: PublicCampaign, today: string) {
  try {
    if (c.popup.frequency === "session") sessionStorage.setItem(seenKey(c.id), "1");
    else localStorage.setItem(seenKey(c.id), today);
  } catch {
    /* storage blocked: it simply won't be remembered */
  }
}

export function OfferPopup({ data }: { data: { today: string; campaigns: PublicCampaign[] } | null }) {
  const pathname = usePathname();
  const { isOpen: sheetOpen } = useRequest();
  const [offer, setOffer] = useState<PublicCampaign | null>(null);
  const [open, setOpen] = useState(false);
  const closeBtn = useRef<HTMLButtonElement>(null);
  // Read inside the timer, so the pop-up waits while the request sheet is open.
  const sheetOpenRef = useRef(sheetOpen);
  useEffect(() => {
    sheetOpenRef.current = sheetOpen;
  }, [sheetOpen]);

  // Pick the offer and start the timer (once per page load). If the visitor is
  // busy in the request sheet when it fires, check again every 2 seconds.
  useEffect(() => {
    const today = todayIST();
    const c = liveOffer(data?.campaigns, today, "popup");
    if (!c || pathname === c.content.ctaHref || alreadySeen(c, today)) return;
    let timer = 0;
    const show = () => {
      if (sheetOpenRef.current) {
        timer = window.setTimeout(show, 2000);
        return;
      }
      setOffer(c);
      setOpen(true);
      markSeen(c, today);
    };
    timer = window.setTimeout(show, Math.max(5, c.popup.delaySeconds) * 1000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per page load; a later route change shouldn't re-arm it
  }, [data]);

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    closeBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      prev?.focus?.();
    };
  }, [open]);

  if (!open || !offer) return null;
  const { content } = offer;
  const close = () => setOpen(false);
  const cta = "offer-cta inline-flex h-12 flex-1 items-center justify-center rounded-[var(--radius-control)] px-5 text-[15px] font-semibold";

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-ink/60 p-4 sm:items-center" onClick={close}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="offer-popup-title"
        onClick={(e) => e.stopPropagation()}
        className={`offer-theme-${offer.theme} offer-pop relative w-full max-w-[400px] overflow-hidden rounded-[var(--radius-media)] bg-ivory text-ink shadow-[var(--shadow-sheet)]`}
      >
        <button
          ref={closeBtn}
          onClick={close}
          aria-label="Close offer"
          className="absolute right-3 top-3 z-[2] flex h-11 w-11 items-center justify-center rounded-full bg-ivory/90 text-ink shadow"
        >
          <X className="h-5 w-5" strokeWidth={1.75} />
        </button>

        {/* With a poster: poster on top, headline below. Without: the headline sits
            in the offer colour, once. */}
        {content.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={content.image} alt="" className="block max-h-[46dvh] w-full object-cover" />
        ) : (
          <div className="offer-surface px-6 pb-8 pt-8">
            <div className="relative z-[1] pr-12">
              {content.eyebrow && (
                <span className="offer-blink inline-block rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-[0.14em]">
                  {content.eyebrow}
                </span>
              )}
              <h2 id="offer-popup-title" className="mt-4 font-serif text-[36px] leading-[1.02]">
                {content.headline}
              </h2>
            </div>
          </div>
        )}

        <div className="p-6">
          {content.image && (
            <>
              {content.eyebrow && (
                <span className="offer-blink inline-block rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-[0.14em]">
                  {content.eyebrow}
                </span>
              )}
              <h2 id="offer-popup-title" className="mt-3 font-serif text-[28px] leading-tight">
                {content.headline}
              </h2>
            </>
          )}
          {content.body && <p className={`${content.image ? "mt-2" : ""} text-[15px] leading-[1.55] text-ink-muted`}>{content.body}</p>}
          <p className="mt-3 text-[13px] font-semibold text-ink-muted">Offer valid till {shortDate(offer.endDate)}</p>
          <div className="mt-5 flex items-center gap-3">
            {isInternal(content.ctaHref) ? (
              <Link href={content.ctaHref} onClick={close} className={cta}>
                {content.ctaLabel}
              </Link>
            ) : (
              <a href={content.ctaHref} target="_blank" rel="noopener" onClick={close} className={cta}>
                {content.ctaLabel}
              </a>
            )}
            <button onClick={close} className="h-12 px-3 text-[14px] font-semibold text-ink-muted hover:text-ink">
              Maybe later
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
