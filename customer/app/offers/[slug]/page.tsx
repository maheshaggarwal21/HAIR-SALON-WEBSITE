/**
 * `/offers/<slug>`: one offer's landing page, by its address (D62). For ad links and testing.
 * Works for a live, scheduled or ended offer (the page says which); a paused or unknown address
 * is a 404. `/offers/now` is its own page and wins over this one. (The old hand-built
 * `/offers/karva-chauth` page was removed on 24 Oct 2026, so that address is free for an offer again.)
 *
 * Ad tag: `?c=karwa` rides along into the request (read by the form; the server tidies it).
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getOfferPage, getSite } from "@/lib/api";
import { OfferPageView } from "@/components/offers/OfferPageView";

/**
 * Cache Components needs at least one example address to build this page with, because the
 * site-wide offer pop-up reads the page address. Offers are added by the owner at any time, so
 * there is no list to build from: "offer" is a stand-in that 404s (the same trick as
 * /services/[slug]). Every real offer page renders on its first visit and is then cached.
 */
export function generateStaticParams() {
  return [{ slug: "offer" }];
}

export async function generateMetadata({ params }: PageProps<"/offers/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const o = await getOfferPage(slug);
  if (!o) return { title: "Offer not found", robots: { index: false } };
  return { title: `${o.headline} · The Experts, Patiala`, description: o.offerText ?? undefined, alternates: { canonical: `/offers/${o.slug}` } };
}

async function Offer({ params }: { params: PageProps<"/offers/[slug]">["params"] }) {
  const { slug } = await params;
  const [offer, site] = await Promise.all([getOfferPage(slug), getSite()]);
  if (!offer) notFound();
  return <OfferPageView offer={offer} site={site} />;
}

export default function OfferSlugPage({ params }: PageProps<"/offers/[slug]">) {
  return (
    <Suspense fallback={null}>
      <Offer params={params} />
    </Suspense>
  );
}
