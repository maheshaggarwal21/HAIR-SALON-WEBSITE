"use client";

/**
 * Reels wall (DS §5 ReelTile, §6.1 §8, T1.20).
 *
 *   - 9:16 tiles; a tile's video plays (muted) only while ≥ 60% visible;
 *   - on phones only ONE plays at a time (DS §9) — the most visible wins;
 *   - videos load nothing until they come near the viewport (preload="none");
 *   - tap → lightbox with sound and "Book this look" when the reel is tagged
 *     with a service; Escape or the close button shuts it;
 *   - reduced motion: no autoplay at all, posters only, tap to play.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { PublicReel } from "@/lib/types";
import { useRequest } from "@/components/request/RequestContext";

function usePlaybackPolicy() {
  const [policy, setPolicy] = useState<{ autoplay: boolean; single: boolean }>({ autoplay: false, single: true });
  useEffect(() => {
    const id = requestAnimationFrame(() =>
      setPolicy({
        autoplay: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        single: !window.matchMedia("(min-width: 768px)").matches,
      })
    );
    return () => cancelAnimationFrame(id);
  }, []);
  return policy;
}

export function ReelsWall({ reels, instagram }: { reels: PublicReel[]; instagram: string | null }) {
  const { autoplay, single } = usePlaybackPolicy();
  const videos = useRef(new Map<string, HTMLVideoElement>());
  const ratios = useRef(new Map<string, number>());
  const [open, setOpen] = useState<PublicReel | null>(null);

  const apply = useCallback(() => {
    if (!autoplay || open) {
      videos.current.forEach((v) => v.pause());
      return;
    }
    const visible = [...ratios.current.entries()].filter(([, r]) => r >= 0.6);
    const allowed = single ? visible.sort((a, b) => b[1] - a[1]).slice(0, 1).map(([id]) => id) : visible.map(([id]) => id);
    videos.current.forEach((v, id) => {
      if (allowed.includes(id)) v.play().catch(() => {});
      else v.pause();
    });
  }, [autoplay, single, open]);

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) ratios.current.set((e.target as HTMLElement).dataset.reel!, e.intersectionRatio);
        apply();
      },
      { threshold: [0, 0.3, 0.6, 0.9] }
    );
    videos.current.forEach((v) => io.observe(v));
    return () => io.disconnect();
  }, [apply, reels]);

  return (
    <>
      <div className="snap-row md:grid md:grid-flow-row md:grid-cols-3 md:overflow-visible lg:grid-cols-4">
        {reels.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => setOpen(r)}
            className="group relative aspect-[9/16] overflow-hidden rounded-[var(--radius-media)] bg-sand text-left"
            aria-label={r.caption ? `Play reel: ${r.caption}` : "Play reel"}
          >
            {r.mediaType === "video" ? (
              <video
                ref={(el) => {
                  if (el) videos.current.set(r.id, el);
                  else videos.current.delete(r.id);
                }}
                data-reel={r.id}
                src={r.mediaUrl}
                poster={r.thumbnailUrl ?? undefined}
                muted
                loop
                playsInline
                preload="none"
                className="h-full w-full object-cover"
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={r.mediaUrl} alt={r.caption ?? ""} loading="lazy" className="h-full w-full object-cover" />
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
