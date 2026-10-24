/**
 * OfferPageView — an offer's landing page (D62), shared by /offers/now and /offers/<slug>.
 *
 * One job: turn a visitor from an ad into a REQUEST. Headline, the offer in plain words, the
 * price as written by the owner, then the form. No payment, no code. Honest by design:
 * the end date is the real one, there is no countdown or "only N left", and the page says
 * plainly that the price is the offer's and is given at the salon.
 *
 * `scheduled` and `ended` offers (reached by their address) say so and offer the normal
 * booking link instead of a form that the server would refuse.
 */

import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { OfferSlideshow, type Slide } from "@/components/offers/OfferSlideshow";
import { WaRequestForm } from "@/components/offers/WaRequestForm";
import { offerTill, rupees } from "@/lib/format";
import type { OfferPageData, SiteInfo } from "@/lib/types";

export function OfferPageView({ offer, site }: { offer: OfferPageData; site: SiteInfo | null }) {
  const live = offer.state === "live";
  // The reel (if the owner chose one) leads, then the pictures in her order; older pages fall back to their one picture.
  const slides: Slide[] = [
    ...(offer.reel ? [{ kind: offer.reel.mediaType, src: offer.reel.mediaUrl, poster: offer.reel.thumbnailUrl } as Slide] : []),
    ...(offer.images?.length ? offer.images : offer.image ? [offer.image] : []).map((src): Slide => ({ kind: "image", src })),
  ];
  return (
    <main className="flex-1 pb-24 md:pb-0">
      <section className={`offer-theme-${offer.theme} bg-[linear-gradient(135deg,var(--offer-a),var(--offer-b))] px-4 py-16 text-ivory md:px-16 md:py-28`}>
        <div className="mx-auto grid max-w-site gap-10 md:grid-cols-[1.1fr_0.9fr] md:items-center">
          <div>
            {offer.eyebrow && <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--offer-glow)] md:text-[13px]">{offer.eyebrow}</p>}
            <h1 className="mt-4 font-serif text-[40px] leading-[1.02] tracking-[-0.02em] md:text-[72px]">{offer.headline}</h1>
            {offer.offerText && <p className="mt-6 max-w-[560px] text-[18px] leading-[1.6] text-ivory/90">{offer.offerText}</p>}
            {offer.price != null && (
              <p className="mt-6 flex items-baseline gap-3">
                <span className="tabular font-serif text-[48px] leading-none text-[var(--offer-glow)] md:text-[64px]">{rupees(offer.price)}</span>
                {offer.priceNote && <span className="text-[16px] text-ivory/80">{offer.priceNote}</span>}
              </p>
            )}
            <p className="mt-4 text-[14px] text-ivory/75">
              {live ? `On until ${offerTill(offer.endDate)}.` : offer.state === "scheduled" ? `Starts ${offerTill(offer.startDate)}.` : `This offer ended on ${offerTill(offer.endDate)}.`}
            </p>
          </div>
          {slides.length > 0 && <OfferSlideshow slides={slides} />}
        </div>
      </section>

      <section className="bg-ivory px-4 py-14 md:px-16 md:py-24">
        <div className="mx-auto max-w-[640px]">
          {live && site ? (
            <>
              <h2 className="font-serif text-[32px] leading-tight md:text-[44px]">
                Ask for your <em className="text-gold">time</em>.
              </h2>
              <p className="mt-3 text-[16px] leading-[1.6] text-ink-muted">
                Pick a day and time. We confirm it on WhatsApp. The offer price is given at the salon when you pay after your visit.
              </p>
              <div className="mt-8">
                <WaRequestForm
                  site={site}
                  offerSlug={offer.slug}
                  packages={offer.packages?.length ? offer.packages : undefined}
                  fixedServices={offer.packages?.length ? undefined : offer.services}
                  minutesNeeded={Math.max(60, offer.services.length * 30)}
                />
              </div>
            </>
          ) : (
            <NotRunning state={offer.state} />
          )}
        </div>
      </section>
    </main>
  );
}

/** No offer is running (or this one is not): say so kindly and point to the normal booking. */
export function NoOffer() {
  return (
    <main className="flex-1 pb-24 md:pb-0">
      <section className="bg-ivory-2 px-4 py-20 md:px-16 md:py-32">
        <div className="mx-auto max-w-[640px]">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-muted md:text-[13px]">The Experts · Patiala</p>
          <h1 className="mt-4 font-serif text-[40px] leading-[1.05] md:text-[64px]">No offer on right now.</h1>
          <p className="mt-5 text-[17px] leading-[1.6] text-ink-muted">
            Our next offer will be here when it starts. You can still book your visit at our usual prices.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button href="/book">Book a visit</Button>
            <Button href="/services" variant="secondary">
              See the menu
            </Button>
          </div>
        </div>
      </section>
    </main>
  );
}

function NotRunning({ state }: { state: OfferPageData["state"] }) {
  return (
    <div>
      <h2 className="font-serif text-[30px] leading-tight md:text-[40px]">{state === "scheduled" ? "This offer has not started yet." : "This offer has ended."}</h2>
      <p className="mt-3 text-[16px] leading-[1.6] text-ink-muted">You can still book your visit at our usual prices.</p>
      <div className="mt-6 flex flex-wrap gap-3">
        <Button href="/book">Book a visit</Button>
        <Link href="/services" className="inline-flex h-12 items-center px-2 text-[15px] font-semibold underline">
          See the menu
        </Link>
      </div>
    </div>
  );
}
