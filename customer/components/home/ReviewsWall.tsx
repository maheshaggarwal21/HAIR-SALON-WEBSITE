/**
 * Reviews (DS §6.1 §10, CF D27): the Google rating as a big serif number with
 * gold stars, then review cards that drift slowly sideways in a loop.
 *
 * Server component, pure CSS (globals.css `.review-*`), so it costs phones no
 * JavaScript:
 *   - the list is rendered twice and the track slides by exactly half, so the
 *     loop has no seam; the second copy is hidden and inert, so screen readers
 *     and the Tab key see each review once;
 *   - speed scales with the number of cards (about 9s each);
 *   - hover or keyboard focus pauses it, so a review can be read;
 *   - reduced motion: no drift, just a row you can swipe.
 *
 * Stats row (CF D28): Google rating, clients served and Google reviews, each
 * counting up when scrolled into view. Rating and review count are Google's;
 * clients served is counted from paid visits by the server. "+" figures are
 * rounded DOWN, so they never read higher than the truth. A stat with no real
 * number behind it is left out, never filled in.
 *
 * Honesty: the rating and count are Google's, never invented; with the owner's
 * selected reviews the label says "selected", and there is always a link to all
 * reviews on Google.
 */

import type { ReactNode } from "react";
import type { PublicReviews, SiteInfo } from "@/lib/types";
import { CountUp } from "@/components/motion/CountUp";
import { floorNice } from "@/lib/format";

type Review = PublicReviews["reviews"][number];

function Stars({ value, className = "" }: { value: number; className?: string }) {
  const full = Math.round(value);
  return (
    <span className={`text-gold ${className}`} aria-label={`${value} out of 5 stars`}>
      {"★".repeat(full)}
      <span className="text-line">{"★".repeat(5 - full)}</span>
    </span>
  );
}

function ReviewCard({ r }: { r: Review }) {
  return (
    <figure className="flex w-[300px] shrink-0 flex-col rounded-[var(--radius-card)] border border-line bg-ivory p-6 md:w-[380px] md:p-7">
      <Stars value={r.rating} className="text-[17px] tracking-[0.12em]" />
      <blockquote className="mt-4 line-clamp-6 flex-1 font-serif text-[21px] leading-[1.3] md:text-[24px]">“{r.text}”</blockquote>
      <figcaption className="mt-6 flex items-center justify-between gap-3 border-t border-line pt-4 text-[14px]">
        <span className="min-w-0">
          {r.authorUri ? (
            <a href={r.authorUri} target="_blank" rel="noopener" className="font-semibold hover:underline">
              {r.author}
            </a>
          ) : (
            <span className="font-semibold">{r.author}</span>
          )}
          {r.service && <span className="block truncate text-ink-muted">{r.service}</span>}
          {!r.service && r.relativeTime && <span className="block text-ink-muted">{r.relativeTime}</span>}
        </span>
        <span className="shrink-0 text-[12px] font-semibold uppercase tracking-[0.14em] text-gold-deep">Google</span>
      </figcaption>
    </figure>
  );
}

function Stat({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="min-w-0">
      <div className="whitespace-nowrap font-serif text-[44px] leading-none tracking-[-0.02em] md:text-[72px]">{children}</div>
      <div className="mt-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-muted md:text-[12px]">{label}</div>
    </div>
  );
}

export function ReviewsWall({ reviews, site }: { reviews: PublicReviews; site: SiteInfo | null }) {
  const rating = site?.rating ?? null;
  const value = rating?.value ?? reviews.rating;
  const count = rating?.count ?? reviews.count;
  const link = rating?.mapsUri ?? reviews.mapsUri ?? null;
  const clients = site?.stats?.clientsServed ?? null;
  const reviewsNice = count != null && count >= 10 ? floorNice(count) : null;
  const list = reviews.reviews;
  const seconds = Math.max(30, list.length * 9);
  const hasStats = value != null || clients != null || reviewsNice != null;

  return (
    <div>
      {/* Same gutter + 1240px column as every other home section. */}
      <div className="px-4 md:px-16">
        <div className="mx-auto flex max-w-[1240px] flex-wrap items-end justify-between gap-8">
          <div className="reveal">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gold-deep md:text-[13px]">Reviews</p>
            <h2 className="mt-4 font-serif text-[34px] leading-[1.05] md:text-[64px]">
              In their <em className="text-gold">words</em>.
            </h2>
          </div>
          {hasStats && (
            <div className="reveal grid w-full grid-cols-3 gap-4 md:w-auto md:gap-0 md:divide-x md:divide-line [&>*]:md:px-10 [&>*:first-child]:md:pl-0 [&>*:last-child]:md:pr-0">
              {value != null && (
                <Stat label="Google rating">
                  <CountUp value={value} decimals={1} />
                  <span className="ml-1 text-[0.6em] text-gold" aria-hidden>
                    ★
                  </span>
                </Stat>
              )}
              {clients != null && (
                <Stat label="Clients served">
                  <CountUp value={clients} />
                  <span className="text-gold">+</span>
                </Stat>
              )}
              {reviewsNice != null && (
                <Stat label="Google reviews">
                  <CountUp value={reviewsNice} />
                  <span className="text-gold">+</span>
                </Stat>
              )}
            </div>
          )}
        </div>
      </div>

      {list.length > 0 && (
        <div className="review-marquee mt-12 md:mt-16" style={{ ["--review-duration" as string]: `${seconds}s` }}>
          <div className="review-track">
            {[0, 1].map((copy) => (
              <div key={copy} className="review-group" aria-hidden={copy === 1 || undefined} inert={copy === 1 || undefined}>
                {list.map((r, i) => (
                  <ReviewCard key={`${copy}-${i}`} r={r} />
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="px-4 md:px-16">
        <p className="mx-auto mt-8 max-w-[1240px] text-[13px] text-ink-muted">
          {reviews.attribution}
          {link && (
            <>
              {reviews.attribution ? " · " : ""}
              <a href={link} target="_blank" rel="noopener" className="font-semibold text-gold-deep underline underline-offset-2">
                {count ? `Read all ${count.toLocaleString("en-IN")} on Google` : "Read all on Google"}
              </a>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
