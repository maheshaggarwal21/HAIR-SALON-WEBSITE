/**
 * ServiceCard — DESIGN.md §5. Name, one-line benefit, price, duration, badges.
 *
 * Presentational: the request sheet passes `selectedOptionIds` and `onToggle`
 * to make it selectable; on a plain page it renders as a static card. Variants
 * ("Short / Medium / Long") show as option chips, each a real service.
 *
 * `showImage` adds the service photo on top (3:2, lib/serviceImages.ts). The
 * box reserves its height before the photo loads (no layout shift), and the
 * card fills its grid cell with the price pinned to the bottom, so a row stays
 * even when a title wraps to two lines. The request sheet leaves photos off to
 * keep the picking list short and quick to load.
 */

"use client";

import { Check } from "lucide-react";
import type { ServiceCard as Card } from "@/lib/types";
import { getServiceImage } from "@/lib/serviceImages";
import { Chip } from "./Chip";
import { PriceTag } from "./PriceTag";

export function ServiceCard({
  service,
  selectedOptionIds,
  onToggle,
  tone = "light",
  showImage = false,
  imageSizes = CARD_SIZES,
  fill = false,
}: {
  service: Card;
  selectedOptionIds?: string[];
  onToggle?: (optionId: string) => void;
  tone?: "light" | "dark";
  showImage?: boolean;
  /** `sizes` for the photo; see CARD_SIZES. */
  imageSizes?: string;
  /** Grow to fill a flex column (grid cells), so a row of cards stays even. */
  fill?: boolean;
}) {
  const single = service.options.length === 1 ? service.options[0] : null;
  const selectable = Boolean(onToggle);
  const isSelected = (id: string) => selectedOptionIds?.includes(id) ?? false;
  const anySelected = service.options.some((o) => isSelected(o.id));

  const surface =
    tone === "dark" ? "bg-ink-2 text-ivory border-line-dark" : "bg-ivory text-ink border-line";
  const muted = tone === "dark" ? "text-ivory-muted" : "text-ink-muted";

  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-serif text-[24px] leading-tight md:text-[28px]">{service.name}</h3>
          {service.shortDescription && <p className={`mt-1 text-[15px] leading-[1.5] ${muted}`}>{service.shortDescription}</p>}
        </div>
        {selectable && single && (
          <span
            aria-hidden
            className={`mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border ${
              anySelected ? "border-ink bg-ink text-ivory" : tone === "dark" ? "border-line-dark" : "border-line"
            }`}
          >
            {anySelected && <Check className="h-4 w-4" strokeWidth={2} />}
          </span>
        )}
      </div>

      {(service.requiresConsultation || service.requiresPatchTest) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {service.requiresConsultation && (
            <span className="rounded-full bg-sand px-3 py-1 text-[12px] font-semibold text-gold-deep">Consultation first</span>
          )}
          {service.requiresPatchTest && (
            <span className="rounded-full bg-sand px-3 py-1 text-[12px] font-semibold text-gold-deep">Patch test 48h before</span>
          )}
        </div>
      )}

      <div className="mt-auto pt-4">
        {single ? (
          <PriceTag price={single.price} durationMinutes={single.durationMinutes} />
        ) : (
          <>
            <PriceTag price={service.fromPrice} from />
            <div className="mt-3 flex flex-wrap gap-2" role={selectable ? "group" : undefined} aria-label={`${service.name} options`}>
              {service.options.map((o) =>
                selectable ? (
                  <Chip key={o.id} tone={tone} selected={isSelected(o.id)} onClick={() => onToggle?.(o.id)}>
                    {o.label ?? "Option"} · <span className="tabular">₹{o.price.toLocaleString("en-IN")}</span>
                  </Chip>
                ) : (
                  <span key={o.id} className={`text-[13px] ${muted}`}>
                    {o.label}: <span className="tabular">₹{o.price.toLocaleString("en-IN")}</span>
                  </span>
                )
              )}
            </div>
          </>
        )}
      </div>
    </>
  );

  const img = showImage ? getServiceImage(service) : null;
  const content = (
    <>
      {img && (
        <div className="aspect-[3/2] w-full overflow-hidden bg-ivory-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- static WebP with our own srcset; next/image adds nothing here */}
          <img
            src={img.src}
            srcSet={img.srcSet}
            sizes={img.srcSet ? imageSizes : undefined}
            alt={img.alt}
            width={640}
            height={427}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover"
          />
        </div>
      )}
      <div className="flex flex-1 flex-col p-5">{body}</div>
    </>
  );
  const frame = `flex w-full flex-col overflow-hidden ${fill ? "flex-1" : ""} rounded-[var(--radius-card)] border text-left ${surface} ${
    anySelected ? "border-gold-deep ring-1 ring-gold-deep" : ""
  }`;

  // A single-option card is one big toggle; a variant card toggles via its chips.
  if (selectable && single) {
    return (
      <button type="button" aria-pressed={anySelected} onClick={() => onToggle?.(single.id)} className={`${frame} transition-colors duration-150`}>
        {content}
      </button>
    );
  }
  return <div className={frame}>{content}</div>;
}

/**
 * Card photo `sizes`. Below 1024px this deliberately reports a small slot, so
 * phones and tablets (2–3x screens) pick the 640px file, about 25 KB, instead
 * of the 1200px one. Bandwidth matters more than the last bit of sharpness on a
 * mid-range Android (DS §9). Desktop cards are about 400px wide.
 */
const CARD_SIZES = "(min-width: 1024px) 400px, 213px";
