"use client";

/**
 * BeforeAfter (DS §5): drag the divider, or use the arrow keys — it's a real
 * range input underneath, so it is keyboard and screen-reader operable (DS §10).
 * `peek` (DS §4): when 60% visible the divider nudges once left and right to
 * show it moves; skipped with reduced motion.
 */

import { useEffect, useRef, useState } from "react";

export function BeforeAfter({ before, after, caption }: { before: string; after: string; caption: string | null }) {
  const [pos, setPos] = useState(50);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = box.current;
    if (!el || !document.documentElement.classList.contains("motion-ok")) return;
    const timers: number[] = [];
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return;
        io.disconnect();
        [38, 62, 50].forEach((p, i) => timers.push(window.setTimeout(() => setPos(p), 250 + i * 350)));
      },
      { threshold: 0.6 }
    );
    io.observe(el);
    return () => {
      io.disconnect();
      timers.forEach(clearTimeout);
    };
  }, []);

  return (
    <figure>
      <div ref={box} className="relative aspect-[4/5] overflow-hidden rounded-[var(--radius-media)] bg-ivory-2 select-none">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={after} alt={caption ? `${caption}, after` : "After"} className="absolute inset-0 h-full w-full object-cover" loading="lazy" />
        <div className="absolute inset-0 transition-[clip-path] duration-300 ease-out" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={before} alt={caption ? `${caption}, before` : "Before"} className="h-full w-full object-cover" loading="lazy" />
        </div>
        <div aria-hidden className="pointer-events-none absolute inset-y-0 w-0.5 bg-ivory transition-[left] duration-300 ease-out" style={{ left: `${pos}%` }}>
          <span className="absolute top-1/2 left-1/2 flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-ivory text-ink shadow">
            ‹›
          </span>
        </div>
        <span className="absolute left-3 top-3 rounded-full bg-ink/70 px-3 py-1 text-[12px] font-semibold text-ivory">Before</span>
        <span className="absolute right-3 top-3 rounded-full bg-ink/70 px-3 py-1 text-[12px] font-semibold text-ivory">After</span>
        <input
          type="range"
          min={0}
          max={100}
          value={pos}
          onChange={(e) => setPos(Number(e.target.value))}
          aria-label={caption ? `Compare before and after: ${caption}` : "Compare before and after"}
          className="absolute inset-0 h-full w-full cursor-ew-resize opacity-0"
        />
      </div>
      {caption && <figcaption className="mt-3 text-[15px] font-medium">{caption}</figcaption>}
    </figure>
  );
}
