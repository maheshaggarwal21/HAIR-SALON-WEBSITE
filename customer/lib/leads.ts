/**
 * Leads: a visitor who has not chosen a package (offer page) or who is just "Interested?" (home page) leaves a name,
 * a mobile number and, if they like, a question. It goes to POST /api/public/leads and lands in the staff app under
 * Bookings → Leads. A request WITH a package goes to /api/public/requests/wa instead (components/offers/WaRequestForm.tsx).
 *
 * Only what the person typed is sent, plus where it came from. The hidden "website" box is a bot trap.
 */
import { readFirstTouch } from "@/components/UtmCapture";

export const QUERY_MAX = 300;

/** 10-digit mobile from what was typed ("+91 98765 43210" and "098765 43210" both work), or "" when it is not one. */
export function mobileDigits(typed: string): string {
  const d = typed.replace(/\D/g, "").replace(/^(91|0)(?=\d{10}$)/, "");
  return /^[6-9]\d{9}$/.test(d) ? d : "";
}

export const nameOk = (typed: string) => /^[\p{L}\p{M} .'-]{2,60}$/u.test(typed.trim());

export type LeadResult = { ok: true; duplicate: boolean } | { ok: false; message: string };

export async function postLead(input: {
  name: string;
  phone: string;
  query?: string;
  source: "offer_page" | "landing";
  offerSlug?: string | null;
  campaign?: string | null;
  trap?: string;
}): Promise<LeadResult> {
  const utm = readFirstTouch();
  try {
    const res = await fetch("/api/public/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: input.name.trim(),
        phone: input.phone,
        ...(input.query?.trim() ? { query: input.query.trim() } : {}),
        source: input.source,
        ...(input.offerSlug ? { offerSlug: input.offerSlug } : {}),
        ...(input.campaign ? { campaign: input.campaign } : {}),
        ...(utm ? { utm } : {}),
        website: input.trap ?? "",
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, message: data.message || "That didn't go through. Try again, or message us on WhatsApp." };
    return { ok: true, duplicate: Boolean(data.duplicate) };
  } catch {
    return { ok: false, message: "You seem to be offline. Check your connection and try again." };
  }
}
