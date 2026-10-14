"use client";

/**
 * Open/close state for the request sheet, shared by every "Request" button on
 * the page and by the sticky mobile bar (which hides while the sheet is open,
 * DS §5).
 *
 * In the CP1 rollback mode (NEXT_PUBLIC_BOOKING_MODE=whatsapp) the same
 * buttons become WhatsApp links and the form never opens.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
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
}

const Ctx = createContext<RequestState | null>(null);

export function RequestProvider({
  whatsappNumber,
  formAvailable,
  children,
}: {
  whatsappNumber: string | null;
  formAvailable: boolean;
  children: ReactNode;
}) {
  const [isOpen, setOpen] = useState(false);
  const [preset, setPreset] = useState<RequestPreset>({});
  const [openedAt, setOpenedAt] = useState<Date | null>(null);
  const formEnabled = formAvailable && BOOKING_MODE === "request";

  const open = useCallback(
    (p: RequestPreset = {}) => {
      if (!formEnabled) return;
      setPreset(p);
      setOpenedAt(new Date());
      setOpen(true);
    },
    [formEnabled]
  );
  const close = useCallback(() => setOpen(false), []);
  const whatsapp = whatsappHref(whatsappNumber, "Hi, I'd like to book an appointment at The Experts.");

  const value = useMemo(
    () => ({ isOpen, preset, openedAt, open, close, whatsapp, formEnabled }),
    [isOpen, preset, openedAt, open, close, whatsapp, formEnabled]
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
  label = "Request your slot",
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
  const { open, formEnabled, whatsapp } = useRequest();
  if (formEnabled) {
    return (
      <Button variant={variant} tone={tone} className={className} onClick={() => open(preset)} aria-haspopup="dialog">
        {label}
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
