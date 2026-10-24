"use client";

/**
 * OfferSlideshow — the pictures at the top of an offer page (D63): up to 5 posters or photos,
 * plus an optional reel as the first slide. Swipe or use the arrows and dots; it also moves on by
 * itself every 5 seconds, and stops when a person touches or hovers it, when the tab is hidden,
 * and always for people who ask their device for reduced motion. The WHOLE picture is shown
 * (never cropped), because a poster's prices are printed near its edges.
 *
 * One slide: no arrows, no dots, no movement.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

export interface Slide {
  kind: "image" | "video";
  src: string;
  poster?: string | null;
}

const EVERY_MS = 5000;

/** The visitor's "reduce motion" setting. Until the browser tells us (server render) we assume reduced: no surprise movement. */
const REDUCED = "(prefers-reduced-motion: reduce)";
const watchReduced = (onChange: () => void) => {
  const q = window.matchMedia(REDUCED);
  q.addEventListener("change", onChange);
  return () => q.removeEventListener("change", onChange);
};

export function OfferSlideshow({ slides }: { slides: Slide[] }) {
  const track = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const [held, setHeld] = useState(false);
  const reduced = useSyncExternalStore(watchReduced, () => window.matchMedia(REDUCED).matches, () => true);

  const goTo = useCallback(
    (i: number) => {
      const el = track.current;
      if (!el) return;
      const n = ((i % slides.length) + slides.length) % slides.length;
      el.scrollTo({ left: n * el.clientWidth, behavior: reduced ? "auto" : "smooth" });
      setIndex(n);
    },
    [slides.length, reduced]
  );

  // Keep the dot in step when the visitor swipes.
  const onScroll = () => {
    const el = track.current;
    if (!el || !el.clientWidth) return;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    if (i !== index) setIndex(i);
  };

  useEffect(() => {
    if (slides.length < 2 || held || reduced) return;
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") goTo(index + 1);
    }, EVERY_MS);
    return () => window.clearInterval(t);
  }, [slides.length, held, reduced, index, goTo]);

  if (!slides.length) return null;
  const many = slides.length > 1;

  return (
    <div
      role="region"
      aria-roledescription="carousel"
      aria-label="Offer pictures"
      className="relative overflow-hidden rounded-[var(--radius-media)] bg-black/25"
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onTouchStart={() => setHeld(true)}
      onFocusCapture={() => setHeld(true)}
      onBlurCapture={() => setHeld(false)}
    >
      <div ref={track} onScroll={onScroll} className="flex snap-x snap-mandatory overflow-x-auto scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {slides.map((s, i) => (
          <div key={`${s.src}-${i}`} role="group" aria-roledescription="slide" aria-label={`Picture ${i + 1} of ${slides.length}`} className="aspect-[4/5] w-full shrink-0 snap-center">
            {s.kind === "video" ? (
              <video src={s.src} poster={s.poster ?? undefined} autoPlay muted loop playsInline preload="metadata" className="h-full w-full object-contain" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={s.src} alt="" className="h-full w-full object-contain" loading={i === 0 ? "eager" : "lazy"} draggable={false} />
            )}
          </div>
        ))}
      </div>

      {many && (
        <>
          <button type="button" aria-label="Previous picture" onClick={() => goTo(index - 1)} className="absolute left-2 top-1/2 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-[22px] text-white hover:bg-black/65 md:flex">
            ‹
          </button>
          <button type="button" aria-label="Next picture" onClick={() => goTo(index + 1)} className="absolute right-2 top-1/2 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 text-[22px] text-white hover:bg-black/65 md:flex">
            ›
          </button>
          <div className="absolute inset-x-0 bottom-3 flex justify-center gap-2">
            {slides.map((_, i) => (
              <button key={i} type="button" aria-label={`Show picture ${i + 1}`} aria-current={i === index} onClick={() => goTo(i)} className="flex h-6 w-6 items-center justify-center">
                <span className={`block h-2.5 rounded-full transition-all ${i === index ? "w-6 bg-white" : "w-2.5 bg-white/55"}`} />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
