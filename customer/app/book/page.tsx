/**
 * `/book` — deep link into the booking sheet (DS §6.2, §7):
 *   /book?for=her&service=keratin-medium&artist=mansi&package=karva-chauth-special
 *
 * Ads and WhatsApp links land here; the sheet opens pre-filled over a short
 * page. Works in both modes: live booking (Phase 2) or the request form.
 *
 * `/book?src=wa&c=karwa&p=9876543210&service=<slug>` (D62) shows the unpaid WhatsApp
 * request form instead: service, day and time, name and phone, no payment and no code.
 * The paid sheet is not opened in that mode and is otherwise untouched.
 */

import type { Metadata } from "next";
import { Suspense } from "react";
import { BookOpener } from "@/components/booking/BookOpener";
import { WaBookEntry } from "@/components/offers/WaBookEntry";
import { getServices, getSite } from "@/lib/api";

export const metadata: Metadata = {
  title: "Book an appointment",
  description: "Book hair, skin and beauty services at The Experts, Patiala.",
  alternates: { canonical: "/book" },
};

/** Everything on the public menu, one row per option, for the WhatsApp request form's picker. */
async function WaEntry() {
  const [site, her, him] = await Promise.all([getSite(), getServices("her"), getServices("him")]);
  if (!site) return null;
  const seen = new Set<string>();
  const menu = [...(her ?? []), ...(him ?? [])].flatMap((card) =>
    card.options
      .filter((o) => o.bookingMode !== "walkin_only" && !seen.has(o.id) && seen.add(o.id))
      .map((o) => ({ id: o.id, slug: o.slug, name: o.label && card.options.length > 1 ? `${card.name} — ${o.label}` : card.name }))
  );
  return <WaBookEntry site={site} menu={menu} />;
}

export default function BookPage() {
  return (
    <main className="mx-auto w-full max-w-[640px] px-4 py-16 md:px-0 md:py-24">
      <h1 className="font-serif text-[44px] leading-none md:text-[64px]">
        Book your <em className="text-gold">visit</em>.
      </h1>
      <p className="mt-4 text-[17px] text-ink-muted">Pick your services and a time that suits you.</p>
      <Suspense fallback={null}>
        <BookOpener />
      </Suspense>
      <Suspense fallback={null}>
        <WaEntry />
      </Suspense>
    </main>
  );
}
