/**
 * `/offers/<slug>`: one offer's landing page, by its address (D62). For ad links and testing.
 * Works for a live, scheduled or ended offer (the page says which); a paused or unknown address
 * is a 404. `/offers/karva-chauth` and `/offers/now` are their own pages and win over this one.
 *
 * Ad tag: `?c=karwa` rides along into the request (read by the form; the server tidies it).
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getOfferPage, getSite } from "@/lib/api";
import { OfferPageView } from "@/components/offers/OfferPageView";

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
