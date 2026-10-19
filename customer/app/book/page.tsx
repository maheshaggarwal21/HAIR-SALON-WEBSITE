/**
 * `/book` — deep link into the booking sheet (DS §6.2, §7):
 *   /book?for=her&service=keratin-medium&artist=mansi&package=karva-chauth-special
 *
 * Ads and WhatsApp links land here; the sheet opens pre-filled over a short
 * page. Works in both modes: live booking (Phase 2) or the request form.
 */

import type { Metadata } from "next";
import { Suspense } from "react";
import { BookOpener } from "@/components/booking/BookOpener";

export const metadata: Metadata = {
  title: "Book an appointment",
  description: "Book hair, skin and beauty services at The Experts, Patiala.",
  alternates: { canonical: "/book" },
};

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
    </main>
  );
}
