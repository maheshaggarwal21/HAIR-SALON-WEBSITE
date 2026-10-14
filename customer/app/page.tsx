/**
 * Home `/` (DS §6.1, T1.17). Thirteen sections; any section whose content
 * doesn't exist yet (hero video, before/after pairs, reels, reviews, packages)
 * is left out rather than filled with placeholders (CP2: "no placeholder text
 * anywhere"). Section rhythm (Option H, CF D25): cream → white →
 * cream → white → sand → white marquee → cream → white → cream → sand → white →
 * charcoal footer. No black sections; the footer is the only dark surface.
 *
 * Motion: hero headline `word-rise`, sections `rise` (CSS), signature services
 * `snap-carousel` with arrow buttons (CF D26), marquee,
 * rating `count-up`, before/after `peek`. All honour reduced motion.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { getArtists, getPackages, getReels, getReviews, getServices, getSite } from "@/lib/api";
import { hoursSummary, phoneLabel, rupees, whatsappHref } from "@/lib/format";
import type { ServiceCard as Card } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { ServiceCard } from "@/components/ui/ServiceCard";
import { RequestCta } from "@/components/request/RequestContext";
import { WordRise } from "@/components/motion/WordRise";
import { HeroMedia } from "@/components/home/HeroMedia";
import { RatingBadge } from "@/components/home/RatingBadge";
import { PinnedRow } from "@/components/home/PinnedRow";
import { BeforeAfter } from "@/components/home/BeforeAfter";
import { ReelsWall } from "@/components/home/ReelsWall";
import { ReviewsWall } from "@/components/home/ReviewsWall";
import { ArtistCard } from "@/components/site/ArtistCard";
import { Faq } from "@/components/site/Faq";
import { SalonJsonLd } from "@/components/site/JsonLd";

export const metadata: Metadata = {
  title: { absolute: "The Experts — Hair, Colour, Skin & Bridal Salon in Patiala" },
  alternates: { canonical: "/" },
};

const SIGNATURE_LIMIT = 8;

/** Owner's `featured` services first; otherwise the first card of each category, women's first. */
function signature(her: Card[], him: Card[]) {
  const featured = [...her, ...him].filter((c) => c.featured);
  if (featured.length) return featured.slice(0, SIGNATURE_LIMIT);
  const seen = new Set<string>();
  const out: Card[] = [];
  for (const c of [...her, ...him]) {
    const key = c.displayCategory ?? c.slug;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out.slice(0, SIGNATURE_LIMIT);
}

function Eyebrow({ children, tone = "light" }: { children: React.ReactNode; tone?: "light" | "accent" }) {
  const color = tone === "accent" ? "text-gold-deep" : "text-ink-muted";
  return <p className={`text-xs font-semibold uppercase tracking-[0.18em] md:text-[13px] ${color}`}>{children}</p>;
}

const section = "px-4 py-16 md:px-16 md:py-32";

export default async function Home() {
  const [site, her, him, artists, reels, reviews, packages] = await Promise.all([
    getSite(),
    getServices("her"),
    getServices("him"),
    getArtists(),
    getReels(),
    getReviews(),
    getPackages(),
  ]);
  const herCards = her ?? [];
  const himCards = him ?? [];
  const signatureCards = signature(herCards, himCards);
  const categories = [...new Set([...herCards, ...himCards].map((c) => c.displayCategory).filter(Boolean))] as string[];
  const whatsapp = whatsappHref(site?.contact.whatsapp, "Hi, I'd like to book an appointment at The Experts.");
  const media = site?.media;

  return (
    <main className="flex-1 pb-24 md:pb-0">
      {site && <SalonJsonLd site={site} />}

      {/* 1. Hero (cream) */}
      <section className="bg-ivory-2 px-4 pb-16 pt-16 md:px-16 md:pb-24 md:pt-28">
        <div className="mx-auto max-w-[1240px]">
          <Eyebrow tone="accent">The Experts · Patiala</Eyebrow>
          <h1 className="mt-6 max-w-[12ch] font-serif text-[44px] leading-none tracking-[-0.02em] md:text-[96px]">
            <WordRise text="Hair that *turns* heads." />
          </h1>
          <p className="mt-8 max-w-[640px] text-[17px] leading-[1.6] text-ink-muted md:text-[19px]">
            Colour, keratin, skin, makeup and grooming on Sirhind–Patiala Rd. Real prices online — choose your services and
            we&apos;ll fix a time with you.
          </p>
          <div id="hero-cta" className="mt-10 flex flex-wrap items-center gap-3">
            <RequestCta label="Request a slot" />
            {whatsapp && (
              <Button variant="whatsapp" href={whatsapp} target="_blank" rel="noopener">
                WhatsApp us
              </Button>
            )}
          </div>
          {site?.rating && (
            <div className="mt-8">
              <RatingBadge rating={site.rating} tone="light" />
            </div>
          )}
        </div>
        {media?.heroVideoUrl && <HeroMedia video={media.heroVideoUrl} poster={media.heroPosterUrl} />}
      </section>

      {/* 2. Offers: the site-wide offer bar and pop-up in the root layout (CF D29). */}

      {/* 3. For her / For him (white, with sand and cream panels) */}
      <section className={`bg-ivory ${section}`}>
        <div className="reveal mx-auto grid max-w-[1240px] gap-4 md:grid-cols-2">
          {(
            [
              { key: "her", title: "For her", image: media?.forHerImage, cards: herCards, tone: "bg-sand text-ink" },
              { key: "him", title: "For him", image: media?.forHimImage, cards: himCards, tone: "bg-ivory-2 text-ink" },
            ] as const
          ).map((p) => {
            const cats = [...new Set(p.cards.map((c) => c.displayCategory).filter(Boolean))].slice(0, 5);
            return (
              <div key={p.key} className={`relative flex min-h-[340px] flex-col justify-end overflow-hidden rounded-[var(--radius-media)] p-6 md:min-h-[480px] md:p-10 ${p.tone}`}>
                {p.image && (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.image} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
                    <div aria-hidden className="absolute inset-0 bg-gradient-to-t from-ink/80 via-ink/20 to-transparent" />
                  </>
                )}
                <div className={`relative ${p.image ? "text-ivory" : ""}`}>
                  <h2 className="font-serif text-[44px] leading-none md:text-[64px]">{p.title}</h2>
                  {cats.length > 0 && <p className="mt-3 text-[15px] opacity-80">{cats.join(" · ")}</p>}
                  <div className="mt-6 flex flex-wrap gap-3">
                    <Button variant="secondary" tone={p.image ? "dark" : "light"} href={`/services?for=${p.key}`}>
                      See the menu
                    </Button>
                    <RequestCta preset={{ audience: p.key }} label="Request" variant="secondary" tone={p.image ? "dark" : "light"} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* 4. Signature services (cream) */}
      {signatureCards.length > 0 && (
        <section className={`bg-ivory-2 ${section}`}>
          <div className="mx-auto max-w-[1240px]">
            <div className="reveal flex flex-wrap items-end justify-between gap-4">
              <div>
                <Eyebrow tone="accent">Signature services</Eyebrow>
                <h2 className="mt-4 max-w-[16ch] font-serif text-[34px] leading-[1.05] md:text-[64px]">
                  What we&apos;re <em className="text-gold">known</em> for.
                </h2>
              </div>
              <Link href="/services" className="text-[15px] font-semibold text-gold-deep underline-offset-4 hover:underline">
                Full menu →
              </Link>
            </div>
            <div className="mt-10">
              <PinnedRow>
                {signatureCards.map((c) => (
                  <div key={c.slug} className="flex min-w-0 flex-col">
                    <ServiceCard service={c} />
                    <Link href={`/services/${c.slug}`} className="mt-3 text-[14px] font-semibold text-ink-muted hover:text-ink">
                      Details →
                    </Link>
                  </div>
                ))}
              </PinnedRow>
            </div>
          </div>
        </section>
      )}

      {/* 5. Transformations (white) — consented pairs only */}
      {site && site.transformations.length > 0 && (
        <section className={`bg-ivory ${section}`}>
          <div className="mx-auto max-w-[1240px]">
            <div className="reveal">
              <Eyebrow>Transformations</Eyebrow>
              <h2 className="mt-4 font-serif text-[34px] leading-[1.05] md:text-[64px]">
                Before, and <em className="text-gold">after</em>.
              </h2>
            </div>
            <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {site.transformations.slice(0, 6).map((t) => (
                <BeforeAfter key={t.id} before={t.before} after={t.after} caption={t.caption} />
              ))}
            </div>
          </div>
        </section>
      )}

      {/* 6. Artists (sand) */}
      {artists && artists.length > 0 && (
        <section className={`bg-sand ${section}`}>
          <div className="mx-auto max-w-[1240px]">
            <div className="reveal flex flex-wrap items-end justify-between gap-4">
              <div>
                <Eyebrow tone="accent">The team</Eyebrow>
                <h2 className="mt-4 font-serif text-[34px] leading-[1.05] md:text-[64px]">
                  Meet the <em className="text-gold-deep">artists</em>.
                </h2>
              </div>
              <Link href="/artists" className="text-[15px] font-semibold text-gold-deep underline-offset-4 hover:underline">
                All artists →
              </Link>
            </div>
            <div className="mt-10 grid grid-cols-2 gap-x-4 gap-y-10 md:grid-cols-3 lg:grid-cols-4">
              {artists.slice(0, 8).map((a) => (
                <ArtistCard key={a.id} artist={a} />
              ))}
            </div>
          </div>
        </section>
      )}

      {/* 7. Marquee (white, thin, gold outline) */}
      {categories.length > 0 && (
        <div aria-hidden className="overflow-hidden border-y border-line bg-ivory py-6 md:py-8">
          <div className="marquee-track">
            {[0, 1].map((copy) => (
              <span key={copy} className="text-outline whitespace-nowrap pr-8 font-serif text-[40px] md:text-[64px]">
                {categories.map((c) => `${c} · `).join("")}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 8. Reels wall (cream) */}
      {reels && reels.length > 0 && (
        <section className={`bg-ivory-2 ${section}`}>
          <div className="mx-auto max-w-[1240px]">
            <div className="reveal mb-10">
              <Eyebrow tone="accent">From the salon</Eyebrow>
              <h2 className="mt-4 font-serif text-[34px] leading-[1.05] md:text-[64px]">
                Fresh from the <em className="text-gold">chair</em>.
              </h2>
            </div>
            <ReelsWall reels={reels.slice(0, 9)} instagram={site?.contact.instagram ?? null} />
          </div>
        </section>
      )}

      {/* 9. Packages (white) */}
      {packages && packages.length > 0 && (
        <section className={`bg-ivory ${section}`}>
          <div className="mx-auto max-w-[1240px]">
            <div className="reveal">
              <Eyebrow>Packages</Eyebrow>
              <h2 className="mt-4 font-serif text-[34px] leading-[1.05] md:text-[64px]">
                More for <em className="text-gold">less</em>.
              </h2>
            </div>
            <div className="mt-10 grid gap-4 md:grid-cols-2">
              {packages.map((p) => {
                const separately = p.items.reduce((s, i) => s + i.price, 0);
                return (
                  <div key={p.slug} className="rounded-[var(--radius-card)] border border-line bg-ivory-2 p-6">
                    <div className="flex items-start justify-between gap-4">
                      <h3 className="font-serif text-[28px] leading-tight md:text-[32px]">{p.name}</h3>
                      <div className="text-right">
                        <span className="tabular text-[20px] font-semibold">{rupees(p.price)}</span>
                        {separately > p.price && <div className="tabular text-[13px] text-ink-muted">{rupees(separately)} if booked separately</div>}
                      </div>
                    </div>
                    <p className="mt-3 text-[15px] text-ink-muted">{p.items.map((i) => i.name).join(" · ")}</p>
                    <div className="mt-6">
                      <RequestCta preset={{ audience: p.audience === "him" ? "him" : "her", packageSlug: p.slug }} label="Request this package" variant="secondary" />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      )}

      {/* 10. Reviews (cream) — Google rating + drifting review cards (CF D27) */}
      {reviews && (reviews.rating != null || reviews.reviews.length > 0 || site?.stats?.clientsServed != null) && (
        <section className="bg-ivory-2 py-16 md:py-32">
          <ReviewsWall reviews={reviews} site={site} />
        </section>
      )}

      {/* 11. Visit us (sand) */}
      {site && (
        <section id="visit" className={`scroll-mt-16 bg-sand ${section}`}>
          <div className="mx-auto grid max-w-[1240px] gap-10 md:grid-cols-2">
            <div className="reveal">
              <Eyebrow tone="accent">Visit us</Eyebrow>
              <h2 className="mt-4 font-serif text-[34px] leading-[1.05] md:text-[64px]">
                Find us <em className="text-gold">easily</em>.
              </h2>
              {site.contact.address && <p className="mt-6 text-[17px] leading-[1.6] md:text-[19px]">{site.contact.address}</p>}
              {site.contact.parkingNote && <p className="mt-2 text-[15px] text-ink-muted">{site.contact.parkingNote}</p>}
              <div className="mt-8 flex flex-wrap gap-3">
                {site.contact.mapUrl && (
                  <Button variant="secondary" href={site.contact.mapUrl} target="_blank" rel="noopener">
                    Directions
                  </Button>
                )}
                {site.contact.phone && (
                  <Button variant="ghost" href={`tel:+91${site.contact.phone}`}>
                    Call {phoneLabel(site.contact.phone)}
                  </Button>
                )}
              </div>
            </div>
            <div className="reveal">
              <h3 className="text-[13px] font-semibold uppercase tracking-[0.18em] text-ink-muted">Opening hours</h3>
              <dl className="mt-4 space-y-2 text-[16px]">
                {hoursSummary(site).map((g) => (
                  <div key={g.days} className="flex justify-between gap-6 border-b border-line pb-2">
                    <dt>{g.days}</dt>
                    <dd className="tabular text-ink-muted">{g.text}</dd>
                  </div>
                ))}
              </dl>
              {site.media.salonImages.length > 0 && (
                <div className="mt-8 grid grid-cols-2 gap-3">
                  {site.media.salonImages.slice(0, 4).map((src) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={src} src={src} alt="Inside the salon" loading="lazy" className="aspect-[4/3] w-full rounded-[var(--radius-card)] object-cover" />
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* 12. FAQ (white) */}
      <section className={`bg-ivory ${section}`}>
        <div className="mx-auto max-w-[840px]">
          <div className="reveal">
            <Eyebrow>Questions</Eyebrow>
            <h2 className="mt-4 font-serif text-[34px] leading-[1.05] md:text-[64px]">
              Good to <em className="text-gold">know</em>.
            </h2>
          </div>
          <div className="mt-10">
            <Faq site={site} />
          </div>
          <div className="mt-12">
            <RequestCta label="Request a slot" />
          </div>
        </div>
      </section>
      {/* 13. Footer — in the root layout */}
    </main>
  );
}
