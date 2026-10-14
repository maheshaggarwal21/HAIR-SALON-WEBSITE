/**
 * Home `/` (DS §6.1, T1.17). Thirteen sections; any section whose content
 * doesn't exist yet (hero video, before/after pairs, reels, reviews, packages)
 * is left out rather than filled with placeholders (CP2: "no placeholder text
 * anywhere"). Section rhythm (Option H, CF D25): cream → white →
 * cream → white → sand (meet the owner) → white marquee → cream → white → cream → sand → white →
 * charcoal footer. No black sections; the footer is the only dark surface.
 *
 * Motion: hero headline `word-rise`, sections `rise` (CSS), signature services
 * `snap-carousel` with arrow buttons (CF D26), marquee,
 * rating `count-up`, before/after `peek`. All honour reduced motion.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { getPackages, getReels, getReviews, getServices, getSite } from "@/lib/api";
import { hoursSummary, phoneLabel, rupees, whatsappHref } from "@/lib/format";
import type { ServiceCard as Card } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { ServiceCard } from "@/components/ui/ServiceCard";
import { RequestCta } from "@/components/request/RequestContext";
import { WordRise } from "@/components/motion/WordRise";
import { HeroSlider } from "@/components/home/HeroSlider";
import { GalleryCarousel } from "@/components/home/GalleryCarousel";
import { RatingBadge } from "@/components/home/RatingBadge";
import { PinnedRow } from "@/components/home/PinnedRow";
import { BeforeAfter } from "@/components/home/BeforeAfter";
import { ReelsWall } from "@/components/home/ReelsWall";
import { ReviewsWall } from "@/components/home/ReviewsWall";
import { imageBySlug } from "@/lib/serviceImages";
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
  const [site, her, him, reels, reviews, packages] = await Promise.all([
    getSite(),
    getServices("her"),
    getServices("him"),
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
  const heroSlides = media?.heroSlides ?? [];
  const owner = site?.owner ?? null;
  const gallery = media?.gallery ?? [];
  const bg = heroSlides.length > 0;

  return (
    <main className="flex-1 pb-24 md:pb-0">
      {site && <SalonJsonLd site={site} />}

      {/* 1. Hero. With slides (CF D31): the salon's own videos and photos play as the
          full background, a dark gradient keeps the text readable, and the text turns
          light. Without slides: the plain cream hero. */}
      <section
        className={`relative isolate overflow-hidden px-4 md:px-16 ${
          bg ? "flex min-h-[max(600px,calc(100svh-112px))] items-end bg-ink pb-24 pt-24 text-ivory md:min-h-[min(720px,calc(100svh-104px))] md:items-center md:pb-24 md:pt-14" : "bg-ivory-2 pb-16 pt-16 md:pb-24 md:pt-28"
        }`}
      >
        {bg && (
          <>
            <HeroSlider slides={heroSlides} />
            {/* Readability: darker where the text sits (bottom on phones, left on desktop). */}
            {/* Phones: shade only the lower part where the text sits, so faces in the upper half stay clear.
                Desktop: shade the left, where the text sits; the video plays clear on the right. */}
            <div aria-hidden className="absolute inset-0 z-10 bg-gradient-to-t from-ink/95 from-0% via-ink/65 via-55% to-ink/10 to-85% md:bg-gradient-to-r md:from-ink/85 md:via-ink/55 md:to-transparent" />
          </>
        )}
        <div className="relative z-10 mx-auto w-full max-w-[1240px]">
          <p className={`text-xs font-semibold uppercase tracking-[0.18em] md:text-[13px] ${bg ? "text-gold drop-shadow-[0_1px_6px_rgba(0,0,0,0.6)]" : "text-gold-deep"}`}>The Experts · Patiala</p>
          <h1 className={`mt-6 max-w-[12ch] font-serif text-[44px] leading-none tracking-[-0.02em] md:text-[96px] ${bg ? "drop-shadow-[0_2px_12px_rgba(0,0,0,0.35)]" : ""}`}>
            <WordRise text="Hair that *turns* heads." />
          </h1>
          <p className={`mt-8 max-w-[560px] text-[17px] leading-[1.6] md:text-[19px] ${bg ? "text-ivory/90 drop-shadow-[0_1px_8px_rgba(0,0,0,0.45)]" : "text-ink-muted"}`}>
            Colour, keratin, skin, makeup and grooming on Sirhind–Patiala Rd. Real prices online — choose your services and
            we&apos;ll fix a time with you.
          </p>
          <div id="hero-cta" className="mt-10 flex flex-wrap items-center gap-3">
            <RequestCta label="Request a slot" className={bg ? "bg-ivory! text-ink! hover:bg-ivory-2!" : ""} />
            {whatsapp && (
              <Button variant="whatsapp" tone={bg ? "dark" : "light"} href={whatsapp} target="_blank" rel="noopener" className={bg ? "bg-ink/30 backdrop-blur" : ""}>
                WhatsApp us
              </Button>
            )}
          </div>
          {site?.rating && (
            <div className="mt-8">
              <RatingBadge rating={site.rating} tone={bg ? "dark" : "light"} />
            </div>
          )}
        </div>
      </section>

      {/* 2. Offers: the site-wide offer bar and pop-up in the root layout (CF D29). */}

      {/* 3. For her / For him (white, with sand and cream panels). Each tile is a
          full-bleed photo (the owner's own from Website Settings, else the salon
          shoot), positioned so the face stays in frame, with a soft cream fade
          behind the text so the title, categories and both buttons stay readable. */}
      <section className={`bg-ivory ${section}`}>
        <div className="reveal mx-auto grid max-w-[1240px] gap-4 md:grid-cols-2">
          {(
            [
              { key: "her", title: "For her", own: media?.forHerImage, stock: imageBySlug("for-her"), focus: "50% 20%", cards: herCards, tone: "bg-sand", fade: "from-sand via-sand/90" },
              { key: "him", title: "For him", own: media?.forHimImage, stock: imageBySlug("for-him"), focus: "70% 22%", cards: himCards, tone: "bg-ivory-2", fade: "from-ivory-2 via-ivory-2/90" },
            ] as const
          ).map((p) => {
            const cats = [...new Set(p.cards.map((c) => c.displayCategory).filter(Boolean))].slice(0, 5);
            return (
              <div key={p.key} className={`relative flex min-h-[440px] flex-col justify-end overflow-hidden rounded-[var(--radius-media)] p-6 text-ink md:min-h-[520px] md:p-10 ${p.tone}`}>
                {/* eslint-disable-next-line @next/next/no-img-element -- static WebP with our own srcset */}
                <img
                  src={p.own ?? p.stock.src}
                  srcSet={p.own ? undefined : p.stock.srcSet}
                  sizes={p.own ? undefined : "(min-width: 768px) 50vw, 100vw"}
                  alt={p.own ? "" : p.stock.alt}
                  width={1200}
                  height={800}
                  loading="lazy"
                  decoding="async"
                  className="absolute inset-0 h-full w-full object-cover"
                  style={{ objectPosition: p.focus }}
                />
                <div aria-hidden className={`absolute inset-x-0 bottom-0 h-[72%] bg-gradient-to-t to-transparent ${p.fade}`} />
                <div className="relative">
                  <h2 className="font-serif text-[44px] leading-none md:text-[64px]">{p.title}</h2>
                  {cats.length > 0 && <p className="mt-3 text-[15px] text-ink-muted">{cats.join(" · ")}</p>}
                  <div className="mt-6 flex flex-wrap gap-3">
                    <Button variant="secondary" href={`/services?for=${p.key}`} className="bg-ivory/70">
                      See the menu
                    </Button>
                    <RequestCta preset={{ audience: p.key }} label="Request" variant="secondary" className="bg-ivory/70" />
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
                    <ServiceCard service={c} showImage fill imageSizes="(min-width: 768px) 360px, 213px" />
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

      {/* 6. Meet the owner (sand, CF D32): words on the left, a large photo on the right. */}
      {owner && (
        <section className={`bg-sand ${section}`}>
          <div className="mx-auto grid max-w-[1240px] items-center gap-10 md:grid-cols-[1.1fr_0.9fr] md:gap-16">
            <div className="reveal">
              <Eyebrow tone="accent">Meet the owner</Eyebrow>
              <h2 className="mt-4 font-serif text-[40px] leading-[1.02] md:text-[72px]">
                {owner.name.split(" ").slice(0, -1).join(" ") || owner.name}{" "}
                {owner.name.includes(" ") && <em className="text-gold-deep">{owner.name.split(" ").slice(-1)[0]}</em>}
              </h2>
              <p className="mt-3 text-[13px] font-semibold uppercase tracking-[0.16em] text-ink-muted">{owner.title}</p>
              <div className="mt-8 max-w-[560px] space-y-4 text-[17px] leading-[1.7] text-ink/85">
                {owner.bio.split(/\n\s*\n/).map((para, k) => (
                  <p key={k}>{para}</p>
                ))}
              </div>
              <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
                <RequestCta label="Request a slot" />
                <Link href="/artists" className="text-[15px] font-semibold text-gold-deep underline-offset-4 hover:underline">
                  Meet the team →
                </Link>
                {site?.contact.instagram && (
                  <a href={`https://instagram.com/${site.contact.instagram}`} target="_blank" rel="noopener" className="text-[15px] font-semibold text-gold-deep underline-offset-4 hover:underline">
                    Instagram →
                  </a>
                )}
              </div>
            </div>
            <div className="reveal">
              {owner.photo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={owner.photo}
                  alt={`${owner.name}, ${owner.title}`}
                  width={900}
                  height={1100}
                  loading="lazy"
                  decoding="async"
                  className="aspect-[4/5] w-full rounded-[var(--radius-media)] object-cover object-[50%_30%] shadow-[var(--shadow-sheet)]"
                />
              ) : (
                <div className="flex aspect-[4/5] w-full items-center justify-center rounded-[var(--radius-media)] bg-ivory-2 font-serif text-[96px] text-ink-muted">
                  {owner.name.split(" ").map((w) => w[0]).join("").slice(0, 2)}
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* 6b. See us in action (white, CF D33): real photos of the salon in a coverflow carousel. */}
      {gallery.length > 0 && (
        <section className={`overflow-hidden bg-ivory ${section}`}>
          <div className="mx-auto max-w-[1240px]">
            <div className="reveal text-center">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gold-deep md:text-[13px]">See us in action</p>
              <h2 className="mt-4 font-serif text-[34px] leading-[1.05] md:text-[64px]">
                Inside the <em className="text-gold">salon</em>.
              </h2>
              <p className="mx-auto mt-4 max-w-[520px] text-[17px] text-ink-muted">Our space, our team, our work. No stock photos.</p>
            </div>
            <div className="mt-12">
              <GalleryCarousel items={gallery} />
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
