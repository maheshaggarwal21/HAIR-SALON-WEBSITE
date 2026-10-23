/**
 * `/offers/now`: whatever offer is on today, India time (D62). One link for every ad.
 *
 * The owner gives offers their own start and end dates; this page shows the one whose dates
 * contain today. If two overlap, the one that ENDS SOONER is shown. When nothing is on it says
 * so kindly and points to normal booking. Nothing about the shown offer is cached for long:
 * the choice changes at midnight IST by itself (lib/api.ts getOfferNow).
 */

import type { Metadata } from "next";
import { Suspense } from "react";
import { getOfferNow, getSite } from "@/lib/api";
import { NoOffer, OfferPageView } from "@/components/offers/OfferPageView";

export const metadata: Metadata = {
  title: "Our offer right now · The Experts, Patiala",
  description: "The offer running at The Experts, Sirhind–Patiala Rd, today. Ask for a time and we confirm it on WhatsApp.",
  alternates: { canonical: "/offers/now" },
};

async function Now() {
  const [now, site] = await Promise.all([getOfferNow(), getSite()]);
  if (!now?.offer) return <NoOffer />;
  return <OfferPageView offer={now.offer} site={site} />;
}

export default function OffersNowPage() {
  return (
    <Suspense fallback={null}>
      <Now />
    </Suspense>
  );
}
