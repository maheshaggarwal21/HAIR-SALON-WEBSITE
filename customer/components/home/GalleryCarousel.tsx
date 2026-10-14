"use client";

/**
 * "See us in action" gallery (CF D33): the active photo large in a white frame
 * with its caption, the neighbours smaller and faded on each side (coverflow).
 * ‹ › arrows, dots, swipe on phones; advances every 5 s while on screen, pauses
 * on hover/focus; reduced motion = no auto-advance and no sliding animation.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

export interface GalleryItem {
  url: string;
  caption: string | null;
}

const AUTO_MS = 5000;

export function GalleryCarousel({ items }: { items: GalleryItem[] }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [inView, setInView] = useState(false);
  const [still, setStill] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const touchX = useRef<number | null>(null);
  const n = items.length;

  const go = useCallback((i: number) => setIndex(((i % n) + n) % n), [n]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setStill(mq.matches);
    const id = requestAnimationFrame(sync);
    mq.addEventListener("change", sync);
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { threshold: 0.3 });
    if (box.current) io.observe(box.current);
    return () => {
      cancelAnimationFrame(id);
      mq.removeEventListener("change", sync);
      io.disconnect();
    };
  }, []);

  useEffect(() => {
    if (still || paused || !inView || n < 2) return;
    const t = window.setTimeout(() => go(index + 1), AUTO_MS);
    return () => window.clearTimeout(t);
  }, [index, still, paused, inView, n, go]);

  if (!n) return null;

  // Shortest way round the loop: -1 is the card to the left, +1 to the right.
  const offset = (i: number) => {
    let d = i - index;
    if (d > n / 2) d -= n;
    if (d < -n / 2) d += n;
    return d;
  };

  const card = "w-[84%] sm:w-[70%] md:w-[58%] lg:w-[52%]";

  return (
    <div
      ref={box}
      role="region"
      aria-roledescription="carousel"
      aria-label="Photos from the salon"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      onTouchStart={(e) => (touchX.current = e.touches[0].clientX)}
      onTouchEnd={(e) => {
        if (touchX.current == null) return;
        const dx = e.changedTouches[0].clientX - touchX.current;
        touchX.current = null;
        if (Math.abs(dx) > 40) go(index + (dx < 0 ? 1 : -1));
      }}
      className="relative select-none"
    >
      {/* Stage: an invisible copy of the centre card gives the stage its height. */}
      <div className="relative">
        <div aria-hidden className={`invisible mx-auto ${card} rounded-[var(--radius-media)] p-3 md:p-4`}>
          <div className="aspect-[3/2]" />
          <p className="mt-3 text-[15px] md:mt-4">&nbsp;</p>
        </div>
        {items.map((it, i) => {
          const d = offset(i);
          const a = Math.abs(d);
          const style = {
            // Side cards at 58% size, fully on screen with a small gap from the centre card.
            transform: `translateX(calc(-50% + ${d * 82}%)) scale(${a === 0 ? 1 : a === 1 ? 0.58 : 0.4})`,
            opacity: a === 0 ? 1 : a === 1 ? 0.8 : 0,
            zIndex: 30 - a,
          };
          return (
            <figure
              key={i}
              role="group"
              aria-roledescription="slide"
              aria-label={`${i + 1} of ${n}${it.caption ? `: ${it.caption}` : ""}`}
              aria-hidden={a !== 0}
              onClick={() => a === 1 && go(i)}
              style={style}
              className={`absolute left-1/2 top-0 ${card} rounded-[var(--radius-media)] bg-ivory p-3 shadow-[var(--shadow-sheet)] md:p-4 ${
                still ? "" : "transition-[transform,opacity] duration-500 ease-[var(--ease-rise)]"
              } ${a === 1 ? "cursor-pointer" : a > 1 ? "pointer-events-none" : ""}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={it.url}
                alt={it.caption ?? "Inside The Experts salon"}
                width={1200}
                height={800}
                loading={a <= 1 ? "eager" : "lazy"}
                decoding="async"
                className="aspect-[3/2] w-full rounded-[var(--radius-card)] object-cover"
              />
              <figcaption className={`mt-3 text-center text-[15px] text-ink-muted md:mt-4 ${a === 0 ? "" : "invisible"}`}>
                {it.caption ?? " "}
              </figcaption>
            </figure>
          );
        })}

        {n > 1 && (
          <>
            <button
              onClick={() => go(index - 1)}
              aria-label="Previous photo"
              className="absolute left-0 top-1/2 z-40 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-ivory text-ink shadow-[var(--shadow-sheet)] hover:bg-ivory-2 md:left-4"
            >
              <ChevronLeft className="h-5 w-5" strokeWidth={1.75} />
            </button>
            <button
              onClick={() => go(index + 1)}
              aria-label="Next photo"
              className="absolute right-0 top-1/2 z-40 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-ivory text-ink shadow-[var(--shadow-sheet)] hover:bg-ivory-2 md:right-4"
            >
              <ChevronRight className="h-5 w-5" strokeWidth={1.75} />
            </button>
          </>
        )}
      </div>

      {n > 1 && (
        <div className="mt-6 flex justify-center gap-2">
          {items.map((_, i) => (
            <button
              key={i}
              onClick={() => go(i)}
              aria-label={`Show photo ${i + 1}`}
              aria-current={i === index}
              className="flex h-6 items-center"
            >
              <span className={`block h-1.5 rounded-full transition-all ${i === index ? "w-6 bg-ink" : "w-1.5 bg-ink/25"}`} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
