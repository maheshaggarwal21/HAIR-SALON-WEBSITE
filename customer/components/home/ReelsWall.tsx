"use client";

/**
 * Reels wall (DS §5 ReelTile, §6.1 §8, T1.20).
 *
 *   - 9:16 tiles; a tile's video plays (muted) only while ≥ 60% visible;
 *   - ONE plays at a time on every screen (DS §9, D58) — the most visible wins. Synced
 *     Instagram videos are full-size files from Instagram's CDN, so several at once
 *     would drag a desktop or a phone;
 *   - a tile is just a lazy-loaded thumbnail until it first scrolls into view; only then
 *     does it get a <video> (preload="none", so still nothing downloads until it plays).
 *     Instagram thumbnails and videos live on a different host, so loading all of them
 *     up front would cost extra connections and bytes before the visitor reaches them;
 *   - tap → lightbox with sound and "Book this look" when the reel is tagged
 *     with a service; Escape or the close button shuts it;
 *   - reduced motion: no autoplay at all, posters only, tap to play.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { PublicReel } from "@/lib/types";
import { useRequest } from "@/components/request/RequestContext";

function useAutoplay() {
  const [autoplay, setAutoplay] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setAutoplay(!window.matchMedia("(prefers-reduced-motion: reduce)").matches));
    return () => cancelAnimationFrame(id);
  }, []);
  return autoplay;
}

export function ReelsWall({ reels, instagram }: { reels: PublicReel[]; instagram: string | null }) {
  const autoplay = useAutoplay();
  const videos = useRef(new Map<string, HTMLVideoElement>());
  const tiles = useRef(new Map<string, HTMLElement>());
  const ratios = useRef(new Map<string, number>());
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());
  const [open, setOpen] = useState<PublicReel | null>(null);

  const apply = useCallback(() => {
    if (!autoplay || open) {
      videos.current.forEach((v) => v.pause());
      return;
    }
    const visible = [...ratios.current.entries()].filter(([, r]) => r >= 0.6);
    const allowed = visible.sort((a, b) => b[1] - a[1]).slice(0, 1).map(([id]) => id);
    videos.current.forEach((v, id) => {
      if (allowed.includes(id)) v.play().catch(() => {});
      else v.pause();
    });
  }, [autoplay, open]);

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        const arrived: string[] = [];
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.reel!;
          ratios.current.set(id, e.intersectionRatio);
          if (e.isIntersecting) arrived.push(id);
        }
        if (arrived.length) setSeen((prev) => (arrived.every((id) => prev.has(id)) ? prev : new Set([...prev, ...arrived])));
        apply();
      },
      { threshold: [0, 0.3, 0.6, 0.9], rootMargin: "200px 0px" }
    );
    tiles.current.forEach((t) => io.observe(t));
    return () => io.disconnect();
  }, [apply, reels]);

  return (
    <>
      <div className="snap-row md:grid md:grid-flow-row md:grid-cols-3 md:overflow-visible lg:grid-cols-4">
        {reels.map((r) => (
          <button
            key={r.id}
            ref={(el) => {
              if (el) tiles.current.set(r.id, el);
              else tiles.current.delete(r.id);
            }}
            data-reel={r.id}
            type="button"
            onClick={() => setOpen(r)}
            className="group relative aspect-[9/16] overflow-hidden rounded-[var(--radius-media)] bg-sand text-left"
            aria-label={r.caption ? `Play reel: ${r.caption}` : "Play reel"}
          >
            {r.mediaType === "video" ? (
              <>
                {r.thumbnailUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={r.thumbnailUrl} alt="" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover" />
                )}
                {seen.has(r.id) && (
                  <video
                    ref={(el) => {
                      if (el) videos.current.set(r.id, el);
                      else videos.current.delete(r.id);
                    }}
                    src={r.mediaUrl}
                    poster={r.thumbnailUrl ?? undefined}
                    muted
                    loop
                    playsInline
                    preload="none"
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                )}
              </>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={r.mediaUrl} alt={r.caption ?? ""} loading="lazy" decoding="async" className="h-full w-full object-cover" />
            )}
            {r.caption && (
              <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink/80 to-transparent p-4 pt-12 text-[14px] font-medium text-ivory">
                {r.caption}
              </span>
            )}
          </button>
        ))}
      </div>
      {instagram && (
        <a
          href={`https://instagram.com/${instagram}`}
          target="_blank"
          rel="noopener"
          className="mt-8 inline-flex text-[15px] font-semibold text-gold-deep underline-offset-4 hover:underline"
        >
          Follow @{instagram}
        </a>
      )}
      {open && <Lightbox reel={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function Lightbox({ reel, onClose }: { reel: PublicReel; onClose: () => void }) {
  const { open, formEnabled } = useRequest();
  const closeBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    closeBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      prev?.focus?.();
    };
  }, [onClose]);

  return (
    <div role="dialog" aria-modal="true" aria-label={reel.caption ?? "Reel"} className="fixed inset-0 z-50 flex items-center justify-center bg-ink/90 p-4">
      <button ref={closeBtn} onClick={onClose} aria-label="Close" className="absolute right-4 top-4 flex h-11 w-11 items-center justify-center rounded-full bg-ivory/10 text-ivory">
        <X className="h-6 w-6" strokeWidth={1.5} />
      </button>
      <div className="flex max-h-full w-full max-w-[420px] flex-col">
        {reel.mediaType === "video" ? (
          <video src={reel.mediaUrl} poster={reel.thumbnailUrl ?? undefined} controls autoPlay playsInline className="max-h-[78dvh] w-full rounded-[var(--radius-card)] bg-ink" />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={reel.mediaUrl} alt={reel.caption ?? ""} className="max-h-[78dvh] w-full rounded-[var(--radius-card)] object-contain" />
        )}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-ivory">
          <span className="text-[15px]">{reel.caption}</span>
          <div className="flex gap-2">
            {reel.permalink && (
              <a href={reel.permalink} target="_blank" rel="noopener" className="text-[14px] text-ivory-muted underline">
                On Instagram
              </a>
            )}
            {reel.service && formEnabled && (
              <button
                onClick={() => {
                  onClose();
                  open({ optionIds: [reel.service!.optionId] });
                }}
                className="h-11 rounded-[var(--radius-control)] bg-ivory px-4 text-[15px] font-semibold text-ink"
              >
                Request this look
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
