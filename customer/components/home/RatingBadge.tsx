/**
 * RatingBadge (DS §5): "4.6 ★ · 128 Google reviews". From the API's daily
 * Google cache, never hardcoded; renders nothing until a real rating exists.
 */

import type { SiteInfo } from "@/lib/types";
import { CountUp } from "@/components/motion/CountUp";
import { floorNice } from "@/lib/format";

export function RatingBadge({ rating, tone = "dark" }: { rating: SiteInfo["rating"]; tone?: "light" | "dark" }) {
  if (!rating) return null;
  // Rounded down with a "+", like the stats row: the count is a floor, never a claim to the exact number.
  const nice = floorNice(rating.count);
  const body = (
    <>
      <span className="font-semibold text-gold" aria-hidden>
        ★
      </span>
      <span className="font-semibold">
        <CountUp value={rating.value} decimals={1} />
      </span>
      <span className={tone === "dark" ? "text-ivory-muted" : "text-ink-muted"}>
        · <span className="tabular">{nice.toLocaleString("en-IN")}+</span> Google reviews
      </span>
    </>
  );
  const cls = `inline-flex items-center gap-2 rounded-full border px-4 py-2 text-[14px] ${
    tone === "dark" ? "border-line-dark" : "border-line"
  }`;
  return rating.mapsUri ? (
    <a href={rating.mapsUri} target="_blank" rel="noopener" className={cls} aria-label={`Rated ${rating.value} out of 5 from ${nice}+ Google reviews`}>
      {body}
    </a>
  ) : (
    <span className={cls}>{body}</span>
  );
}
