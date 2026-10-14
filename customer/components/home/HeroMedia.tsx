"use client";

/**
 * Hero video (DS §6.1 / §4 `card-expand`): the salon's own muted loop, shown
 * as a rounded card that grows to full width as the visitor scrolls (desktop,
 * GSAP ScrollTrigger loaded on demand). Phones get the plain video; reduced
 * motion gets the poster image only, no autoplay (DS §4 rules).
 */

import { useEffect, useRef, useState } from "react";
import { desktopMotionQuery } from "@/components/motion/DesktopMotion";

export function HeroMedia({ video: src, poster }: { video: string; poster: string | null }) {
  const wrap = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  // Reduced motion is read after mount, so the server HTML (poster + video tag)
  // is the same for everyone and nothing jumps on hydration. The tag carries no
  // `autoplay` attribute: the browser would start it before this check runs, and
  // a reduced-motion visitor without a poster would get a moving video (CP2).
  // Playback starts here, only once motion is known to be welcome.
  const [still, setStill] = useState(true);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => {
      setStill(mq.matches);
      if (mq.matches) video.current?.pause();
    };
    const id = requestAnimationFrame(sync);
    mq.addEventListener("change", sync);
    return () => {
      cancelAnimationFrame(id);
      mq.removeEventListener("change", sync);
    };
  }, []);

  // Runs after the <video> is on the page (it replaces the poster <img> once
  // `still` turns false), so the ref is set by the time we ask it to play.
  useEffect(() => {
    if (!still) video.current?.play().catch(() => {});
  }, [still]);

  useEffect(() => {
    if (!window.matchMedia(desktopMotionQuery).matches || !wrap.current || !card.current) return;
    let kill = () => {};
    let cancelled = false;
    Promise.all([import("gsap"), import("gsap/ScrollTrigger")]).then(([{ gsap }, { ScrollTrigger }]) => {
      if (cancelled || !wrap.current || !card.current) return;
      gsap.registerPlugin(ScrollTrigger);
      const tween = gsap.fromTo(
        card.current,
        { scale: 0.92, borderRadius: 28 },
        {
          scale: 1,
          borderRadius: 0,
          ease: "none",
          scrollTrigger: { trigger: wrap.current, start: "top 80%", end: "+=35%", scrub: 0.6 },
        }
      );
      kill = () => {
        tween.scrollTrigger?.kill();
        tween.kill();
      };
    });
    return () => {
      cancelled = true;
      kill();
    };
  }, []);

  return (
    <div ref={wrap} className="mx-auto mt-12 max-w-[1440px] md:mt-20">
      <div ref={card} className="aspect-[4/5] overflow-hidden rounded-[var(--radius-media)] bg-sand will-change-transform md:aspect-[16/9]">
        {still && poster ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={poster} alt="" className="h-full w-full object-cover" />
        ) : (
          <video
            ref={video}
            className="h-full w-full object-cover"
            src={src}
            poster={poster ?? undefined}
            muted
            loop
            playsInline
            preload="metadata"
            aria-hidden
          />
        )}
      </div>
    </div>
  );
}
