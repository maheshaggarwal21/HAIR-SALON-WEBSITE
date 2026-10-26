"use client";

/**
 * Open/close state for the request sheet, shared by every "Request" button on
 * the page and by the sticky mobile bar (which hides while the sheet is open,
 * DS §5).
 *
 * In the CP1 rollback mode (NEXT_PUBLIC_BOOKING_MODE=whatsapp) the same
 * buttons become WhatsApp links and the form never opens.
 *
 * Phase 2 (T2.22): when the API says live booking is on (an artist is online
 * and payments work), the same buttons open the BookingSheet instead —
 * `kind: "book"`. Switching every artist off in the staff app flips the site
 * back to the request form within a minute (CP4 rollback).
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { BOOKING_MODE } from "@/lib/config";
import { whatsappHref } from "@/lib/format";
import { Button } from "@/components/ui/Button";

export interface RequestPreset {
  audience?: "her" | "him";
  packageSlug?: string;
  optionIds?: string[];
  /** "Book with {artist}" deep links pre-fill the preference (DS §5 ArtistCard). */
  artistSlug?: string;
}

export type SheetKind = "book" | "request";

/** The offer page's request form carries this id; on an offer page every call-to-action scrolls to it (see RequestProvider). */
export const OFFER_FORM_ID = "send-request";

/**
 * Where "Book a request" lands: the start of the part the visitor fills in (the "not sure yet" line above the name box for
 * a lead, or the Day picker for a request), not the top of the whole section, which is the long list of package cards.
 */
export const OFFER_FIELDS_ID = "request-fields";

/** The label every call-to-action shows on an offer page. */
export const OFFER_CTA_LABEL = "Book a request";

interface RequestState {
  isOpen: boolean;
  preset: RequestPreset;
  /**
   * When the sheet was last opened. Taken in the click handler (not during
   * render) so "today" in the date strip is the visitor's today, never the
   * build machine's, and each open is a distinct event the sheet can react to.
   */
  openedAt: Date | null;
  open: (preset?: RequestPreset) => void;
  close: () => void;
  /** wa.me link to the salon, or null when the owner hasn't set a number. */
  whatsapp: string | null;
  /** False when the form can't be used: rollback mode, or the menu didn't load. */
  formEnabled: boolean;
  /** Which sheet the buttons open: live booking, or the Phase 1 request form. */
  kind: SheetKind;
  /**
   * True on /offers/*. There the buttons say "Book a request" and scroll down to the offer's own form instead of
   * opening the booking sheet (an offer is asked for, not booked through the six-step sheet).
   */
  onOfferPage: boolean;
}

const Ctx = createContext<RequestState | null>(null);

export function RequestProvider({
  whatsappNumber,
  formAvailable,
  bookingEnabled = false,
  children,
}: {
  whatsappNumber: string | null;
  formAvailable: boolean;
  bookingEnabled?: boolean;
  children: ReactNode;
}) {
  const kind: SheetKind = bookingEnabled ? "book" : "request";
  const [isOpen, setOpen] = useState(false);
  const [preset, setPreset] = useState<RequestPreset>({});
  const [openedAt, setOpenedAt] = useState<Date | null>(null);
  const formEnabled = formAvailable && BOOKING_MODE === "request";

  const pathname = usePathname() ?? "";
  const onOfferPage = pathname.startsWith("/offers/");

  const open = useCallback(
    (p: RequestPreset = {}) => {
      // On an offer page the button goes to the offer's form, whatever the booking mode is.
      if (onOfferPage) {
        const target = document.getElementById(OFFER_FIELDS_ID) ?? document.getElementById(OFFER_FORM_ID);
        if (target) {
          // An instant jump, then one check once the page has settled. A smooth scroll is cut short on phones: Android Chrome
          // interrupts it when the address bar hides, and images loading above shift the page under it.
          const go = () => target.scrollIntoView({ behavior: "auto", block: "start" });
          go();
          window.setTimeout(() => {
            const wanted = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
            if (Math.abs(target.getBoundingClientRect().top - wanted) > 40) go();
          }, 400);
          return;
        }
      }
      if (!formEnabled) return;
      setPreset(p);
      setOpenedAt(new Date());
      setOpen(true);
    },
    [formEnabled, onOfferPage]
  );
  const close = useCallback(() => setOpen(false), []);
  const whatsapp = whatsappHref(whatsappNumber, "Hi, I'd like to book an appointment at The Experts.");

  const value = useMemo(
    () => ({ isOpen, preset, openedAt, open, close, whatsapp, formEnabled, kind, onOfferPage }),
    [isOpen, preset, openedAt, open, close, whatsapp, formEnabled, kind, onOfferPage]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRequest() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useRequest must be used inside <RequestProvider>");
  return v;
}

/**
 * The page's primary call to action. Opens the request sheet, or — when the
 * form is off — links to WhatsApp. Renders nothing if neither is possible, so
 * no button ever leads nowhere.
 */
export function RequestCta({
  preset,
  label,
  variant = "primary",
  tone = "light",
  className = "",
}: {
  preset?: RequestPreset;
  label?: string;
  variant?: "primary" | "secondary";
  tone?: "light" | "dark";
  className?: string;
}) {
  const { open, formEnabled, whatsapp, kind, onOfferPage } = useRequest();
  if (formEnabled || onOfferPage) {
    return (
      <Button variant={variant} tone={tone} className={className} onClick={() => open(preset)} aria-haspopup={onOfferPage ? undefined : "dialog"}>
        {/* Request mode must say "request" (CP1); live booking says "book"; an offer page says "Book a request". */}
        {onOfferPage ? OFFER_CTA_LABEL : label ? (kind === "book" ? label.replace(/^Request/, "Book") : label) : kind === "book" ? "Book your slot" : "Request your slot"}
      </Button>
    );
  }
  if (whatsapp) {
    return (
      <Button variant="whatsapp" tone={tone} className={className} href={whatsapp} target="_blank" rel="noopener">
        Message us on WhatsApp
      </Button>
    );
  }
  return null;
}
