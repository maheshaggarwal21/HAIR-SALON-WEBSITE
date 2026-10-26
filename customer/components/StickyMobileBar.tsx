"use client";

/**
 * StickyMobileBar — DESIGN.md §5, T1.16. Bottom bar on phones: Request ·
 * WhatsApp · Directions. Hidden while the request sheet is open, and on
 * desktop. A button only appears when it can do something: no WhatsApp
 * number or map link set in Website Settings → no button.
 *
 * It also stays down until the element `watchId` (the hero's own CTA) has
 * scrolled out of view, so there is never more than one gold button on screen
 * (DS §3.1).
 */

import { useEffect, useState } from "react";
import { MapPin, MessageCircle } from "lucide-react";
import { OFFER_CTA_LABEL, OFFER_FORM_ID, useRequest } from "./request/RequestContext";

export function StickyMobileBar({ mapUrl, watchId }: { mapUrl: string | null; watchId?: string }) {
  const { isOpen, open, formEnabled, whatsapp, kind, onOfferPage } = useRequest();
  const [pastHero, setPastHero] = useState(!watchId);
  // On an offer page the button scrolls to the offer's form, so it steps aside once the form has clearly arrived (its top is in
  // the upper part of the screen), and is there while the visitor is still reading the offer above it.
  const [formInView, setFormInView] = useState(false);
  useEffect(() => {
    const form = onOfferPage ? document.getElementById(OFFER_FORM_ID) : null;
    if (!form || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => setFormInView(entry.isIntersecting), { rootMargin: "0px 0px -35% 0px", threshold: 0 });
    io.observe(form);
    return () => {
      io.disconnect();
      setFormInView(false);
    };
  }, [onOfferPage]);
  const canAsk = formEnabled || onOfferPage;

  useEffect(() => {
    const el = watchId ? document.getElementById(watchId) : null;
    if (!el || typeof IntersectionObserver === "undefined") {
      // Nothing to watch: show the bar from the first frame.
      const id = requestAnimationFrame(() => setPastHero(true));
      return () => cancelAnimationFrame(id);
    }
    const io = new IntersectionObserver(([entry]) => setPastHero(!entry.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, [watchId]);

  if (!canAsk && !whatsapp && !mapUrl) return null;
  const hidden = isOpen || !pastHero || (onOfferPage && formInView);

  return (
    <div
      className={`fixed inset-x-0 bottom-0 z-40 border-t border-line bg-ivory/95 px-3 pb-[max(env(safe-area-inset-bottom),12px)] pt-3 text-ink backdrop-blur transition-transform duration-300 md:hidden ${
        hidden ? "translate-y-full" : "translate-y-0"
      }`}
      aria-hidden={hidden}
      inert={hidden}
    >
      <div className="flex gap-2">
        {canAsk && (
          <button
            type="button"
            onClick={() => open()}
            aria-haspopup={onOfferPage ? undefined : "dialog"}
            className="h-12 flex-1 rounded-[var(--radius-control)] bg-ink text-[15px] font-semibold text-ivory"
          >
            {onOfferPage ? OFFER_CTA_LABEL : kind === "book" ? "Book a slot" : "Request a slot"}
          </button>
        )}
        {whatsapp && (
          <a
            href={whatsapp}
            target="_blank"
            rel="noopener"
            className={`flex h-12 items-center justify-center gap-2 rounded-[var(--radius-control)] border border-line text-[15px] font-semibold ${
              canAsk ? "w-12" : "flex-1"
            }`}
            aria-label="WhatsApp us"
          >
            <MessageCircle className="h-5 w-5" strokeWidth={1.5} />
            {!canAsk && "WhatsApp"}
          </a>
        )}
        {mapUrl && (
          <a
            href={mapUrl}
            target="_blank"
            rel="noopener"
            className="flex h-12 w-12 items-center justify-center rounded-[var(--radius-control)] border border-line"
            aria-label="Directions"
          >
            <MapPin className="h-5 w-5" strokeWidth={1.5} />
          </a>
        )}
      </div>
    </div>
  );
}
