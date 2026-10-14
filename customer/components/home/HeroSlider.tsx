"use client";

/**
 * Hero background slider (CF D31): the salon's own videos and photos play as the
 * BACKGROUND of the hero, with the headline on top. A video plays to its end, a
 * photo stays 5 s, then the next slide crossfades in; it loops. Small story bars
 * and ‹ › in the corner let visitors step through; a horizontal swipe works on
 * phones.
 *
 * How a vertical reel fills a WIDE screen without losing faces or going soft:
 * cropping a 9:16 reel to a ~2:1 hero keeps only a thin band of each frame
 * (often the ceiling or a forehead) and stretches it 2–4×, which blurs it. So on
 * wide screens the whole frame plays sharp at its own size on the right, its
 * edges faded into a blurred, moving copy of the same video that fills the hero
 * edge to edge. The blurred copy is a tiny canvas painted from the playing video
 * (always in sync, nearly free), so any reel the owner uploads works the same
 * way. Upright photos get the same treatment; wide photos simply fill. On tall
 * screens (phones) a reel already matches the shape and simply fills.
 *
 * A slide may also carry a landscape `wideUrl` (e.g. a face-following 16:9 cut
 * of the reel, or footage filmed in landscape). On wide screens that version
 * fills the whole hero instead; phones keep the upright `url`.
 *
 * Kept light on purpose (DS §9):
 *   - only the current slide has a <video>; the rest are images or nothing;
 *   - videos are muted (autoplay rule) and play only while the hero is on
 *     screen and the tab is visible;
 *   - reduced motion: nothing advances or plays by itself; the first frame
 *     stays still and slides change only when the visitor asks.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

export interface HeroSlide {
  kind: "video" | "image";
  url: string;
  poster: string | null;
  alt: string | null;
  wideUrl?: string | null;
  widePoster?: string | null;
}

const PHOTO_MS = 5000;
/** Feathers the sharp layer's left/right edges into the blurred backdrop. */
const EDGE_FADE = "[mask-image:linear-gradient(to_right,transparent,#000_14%,#000_86%,transparent)]";
const BLUR_BG = "absolute inset-0 h-full w-full scale-110 object-cover blur-2xl brightness-[0.7] saturate-[1.1]";

export function HeroSlider({ slides }: { slides: HeroSlide[] }) {
  const [index, setIndex] = useState(0);
  const [progress, setProgress] = useState(0);
  const [inView, setInView] = useState(false);
  const [pageShown, setPageShown] = useState(true);
  const [still, setStill] = useState(true); // reduced motion; read after mount
  const [wide, setWide] = useState(true); // landscape screen; read after mount
  const [upright, setUpright] = useState<Record<number, boolean>>({}); // photo orientation
  const layer = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const progressRef = useRef(0); // lets a paused photo resume where it stopped
  const count = slides.length;
  const slide = slides[index];

  const go = useCallback(
    (n: number) => {
      setIndex(((n % count) + count) % count);
      setProgress(0);
      progressRef.current = 0;
    },
    [count]
  );
  const next = useCallback(() => go(index + 1), [go, index]);
  const prev = () => go(index - 1);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const shape = window.matchMedia("(min-aspect-ratio: 1/1)");
    const sync = () => {
      setStill(mq.matches);
      setWide(shape.matches);
    };
    const id = requestAnimationFrame(sync);
    mq.addEventListener("change", sync);
    shape.addEventListener("change", sync);
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { threshold: 0.25 });
    if (layer.current) io.observe(layer.current);
    const onVis = () => setPageShown(!document.hidden);
    document.addEventListener("visibilitychange", onVis);
    // Horizontal swipe anywhere on the hero (vertical scrolling is left alone).
    const hero = layer.current?.parentElement;
    let sx = 0;
    let sy = 0;
    const ts = (e: TouchEvent) => {
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
    };
    const te = (e: TouchEvent) => {
      const dx = e.changedTouches[0].clientX - sx;
      const dy = e.changedTouches[0].clientY - sy;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) layer.current?.dispatchEvent(new CustomEvent(dx < 0 ? "slide-next" : "slide-prev"));
    };
    hero?.addEventListener("touchstart", ts, { passive: true });
    hero?.addEventListener("touchend", te, { passive: true });
    return () => {
      cancelAnimationFrame(id);
      mq.removeEventListener("change", sync);
      shape.removeEventListener("change", sync);
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      hero?.removeEventListener("touchstart", ts);
      hero?.removeEventListener("touchend", te);
    };
  }, []);

  // Swipe events → next / prev (kept separate so they always use the current index).
  useEffect(() => {
    const el = layer.current;
    if (!el) return;
    const n = () => next();
    const p = () => go(index - 1);
    el.addEventListener("slide-next", n);
    el.addEventListener("slide-prev", p);
    return () => {
      el.removeEventListener("slide-next", n);
      el.removeEventListener("slide-prev", p);
    };
  }, [next, go, index]);

  const running = inView && pageShown && !still;

  useEffect(() => {
    const v = video.current;
    if (!v || slide?.kind !== "video") return;
    if (running) v.play().catch(() => {});
    else v.pause();
  }, [running, slide, index, wide]);

  // Blurred backdrop for wide screens: paint the playing frame onto a tiny canvas.
  useEffect(() => {
    if (!wide || slide?.kind !== "video") return;
    const v = video.current;
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!v || !c || !ctx) return;
    let frame = 0;
    const paint = () => {
      if (v.readyState >= 2 && v.videoWidth) {
        // Centre band of the frame, shaped like the canvas (16:9).
        const sh = Math.min(v.videoHeight, (v.videoWidth * c.height) / c.width);
        ctx.drawImage(v, 0, (v.videoHeight - sh) / 2, v.videoWidth, sh, 0, 0, c.width, c.height);
      }
    };
    const loop = () => {
      paint();
      frame = requestAnimationFrame(loop);
    };
    v.addEventListener("loadeddata", paint);
    v.addEventListener("seeked", paint);
    if (running) frame = requestAnimationFrame(loop);
    else paint();
    return () => {
      cancelAnimationFrame(frame);
      v.removeEventListener("loadeddata", paint);
      v.removeEventListener("seeked", paint);
    };
  }, [wide, slide, index, running]);

  useEffect(() => {
    if (slide?.kind !== "image" || !running) return;
    let frame = 0;
    let last = performance.now();
    let done = progressRef.current * PHOTO_MS;
    const tick = (now: number) => {
      done += now - last;
      last = now;
      const p = Math.min(1, done / PHOTO_MS);
      progressRef.current = p;
      setProgress(p);
      if (p >= 1) next();
      else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [slide, running, next, index]);

  if (!count) return null;

  const videoEl = (s: HeroSlide, fit: string, src = s.url, poster = s.poster) => (
    <video
      ref={video}
      key={src}
      src={src}
      poster={poster ?? undefined}
      muted
      playsInline
      preload="auto"
      onTimeUpdate={(e) => {
        const v = e.currentTarget;
        if (v.duration) setProgress(v.currentTime / v.duration);
      }}
      onEnded={() => (still ? undefined : next())}
      className={fit}
    />
  );

  return (
    <>
      {/* Background layer: fills the hero */}
      <div ref={layer} aria-hidden className="absolute inset-0 overflow-hidden bg-ink">
        {slides.map((s, i) => {
          const active = i === index;
          const near = active || Math.abs(i - index) === 1 || (index === count - 1 && i === 0);
          const useWide = wide && Boolean(s.wideUrl);
          const still_ = s.kind === "image" ? (useWide ? s.wideUrl : s.url) : useWide ? (s.widePoster ?? s.poster) : s.poster;
          // Wide screen + upright media (and no landscape version) → sharp, whole frame
          // on the right over a blurred fill.
          const framed = wide && !useWide && (s.kind === "video" || upright[i]);
          return (
            <div key={i} className={`absolute inset-0 transition-opacity duration-700 ${active ? "opacity-100" : "opacity-0"}`}>
              {active && s.kind === "video" ? (
                useWide ? (
                  videoEl(s, "h-full w-full object-cover", s.wideUrl!, s.widePoster ?? s.poster)
                ) : framed ? (
                  <>
                    <canvas ref={canvas} width={64} height={36} className={BLUR_BG} />
                    {videoEl(s, `absolute inset-y-0 right-[3%] h-full w-auto max-w-none object-contain ${EDGE_FADE}`)}
                  </>
                ) : (
                  videoEl(s, "h-full w-full object-cover")
                )
              ) : still_ && near ? (
                framed ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={still_} alt="" className={BLUR_BG} />
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={still_} alt="" decoding="async" className={`absolute inset-y-0 right-[3%] h-full w-auto max-w-none object-contain ${EDGE_FADE}`} />
                  </>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={still_}
                    alt=""
                    decoding="async"
                    onLoad={(e) => {
                      const im = e.currentTarget;
                      const up = im.naturalHeight > im.naturalWidth;
                      if (s.kind === "image" && upright[i] !== up) setUpright((u) => ({ ...u, [i]: up }));
                    }}
                    className="h-full w-full object-cover"
                  />
                )
              ) : null}
            </div>
          );
        })}
      </div>

      {/* Controls: bottom-right on phones; bottom-left under the text on wide screens, clear of the video */}
      <div
        role="group"
        aria-roledescription="carousel"
        aria-label="Videos and photos from the salon"
        className="absolute bottom-5 right-4 z-20 flex items-center gap-3 md:bottom-8 md:left-16 md:right-auto"
      >
        <span className="sr-only" aria-live="polite">
          {`Slide ${index + 1} of ${count}${slide.alt ? `: ${slide.alt}` : ""}`}
        </span>
        <div className="flex w-36 gap-1 md:w-52">
          {slides.map((_, i) => (
            <button key={i} onClick={() => go(i)} aria-label={`Go to slide ${i + 1}`} aria-current={i === index} className="flex h-6 flex-1 items-center">
              <span className="block h-[3px] w-full overflow-hidden rounded-full bg-ivory/35">
                <span className="block h-full rounded-full bg-ivory" style={{ width: `${i < index ? 100 : i === index ? Math.round(progress * 100) : 0}%` }} />
              </span>
            </button>
          ))}
        </div>
        <button onClick={prev} aria-label="Previous" className="flex h-11 w-11 items-center justify-center rounded-full border border-ivory/40 bg-ink/30 text-ivory backdrop-blur hover:bg-ink/50">
          <ChevronLeft className="h-5 w-5" strokeWidth={1.75} />
        </button>
        <button onClick={next} aria-label="Next" className="flex h-11 w-11 items-center justify-center rounded-full border border-ivory/40 bg-ink/30 text-ivory backdrop-blur hover:bg-ink/50">
          <ChevronRight className="h-5 w-5" strokeWidth={1.75} />
        </button>
      </div>
    </>
  );
}
