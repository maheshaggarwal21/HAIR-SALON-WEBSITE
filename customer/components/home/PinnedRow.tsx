"use client";

/**
 * Signature-services row (DS §4 `snap-carousel`, CF D26). A native scroll-snap
 * row on every device: swipe on phones, trackpad or the arrow buttons on
 * desktop. No library, nothing pinned.
 *
 * Why not `pin-scroll`: pinning the section with GSAP while the cards travel
 * sideways left a screen-tall empty gap, shifted the page horizontally, and
 * fought the smooth-scroll layer (owner review, 14 Oct 2026). A plain row is
 * faster on phones and predictable everywhere.
 *
 * The arrows scroll by one card and disable themselves at either end. With
 * reduced motion they jump instead of gliding.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

export function PinnedRow({ children, label = "Signature services" }: { children: ReactNode; label?: string }) {
  const track = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });

  const measure = useCallback(() => {
    const el = track.current;
    if (!el) return;
    setEdges({ start: el.scrollLeft <= 4, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4 });
  }, []);

  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const id = requestAnimationFrame(measure);
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      cancelAnimationFrame(id);
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [measure]);

  const step = (dir: 1 | -1) => {
    const el = track.current;
    if (!el) return;
    const card = el.firstElementChild as HTMLElement | null;
    const gap = parseFloat(getComputedStyle(el).columnGap) || 16;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({ left: dir * ((card?.offsetWidth ?? el.clientWidth * 0.8) + gap), behavior: reduce ? "auto" : "smooth" });
  };

  const arrow =
    "hidden h-11 w-11 items-center justify-center rounded-full border border-line bg-ivory text-ink transition-opacity hover:bg-ivory-2 disabled:pointer-events-none disabled:opacity-30 md:flex";

  return (
    <div role="region" aria-roledescription="carousel" aria-label={label}>
      <div ref={track} className="snap-row pb-2">
        {children}
      </div>
      {!(edges.start && edges.end) && (
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className={arrow} onClick={() => step(-1)} disabled={edges.start} aria-label="Previous services">
            <ChevronLeft className="h-5 w-5" strokeWidth={1.5} />
          </button>
          <button type="button" className={arrow} onClick={() => step(1)} disabled={edges.end} aria-label="More services">
            <ChevronRight className="h-5 w-5" strokeWidth={1.5} />
          </button>
        </div>
      )}
    </div>
  );
}
