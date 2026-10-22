/**
 * PriceTag — DESIGN.md §5. "₹500" or "from ₹500", with the duration beside it
 * when one is known.
 *
 * Prices are the real price paid (Service.publicPrice). A crossed-out "was" price
 * is allowed ONLY while a time-boxed offer is running (CLAUDE.md, "Prices shown to
 * customers", D59): the server sends `regularPrice` and `endsOn` only then, so this
 * component never invents one. It shows the normal price crossed out, the price
 * paid, and below it, small, "20% off · till 27 Oct".
 */

import { minutes, offerTill, percentOff, rupees } from "@/lib/format";

export function PriceTag({
  price,
  from = false,
  durationMinutes,
  regularPrice = null,
  endsOn = null,
  className = "",
}: {
  price: number;
  from?: boolean;
  durationMinutes?: number | null;
  /** Only while an offer runs. */
  regularPrice?: number | null;
  endsOn?: string | null;
  className?: string;
}) {
  const pct = regularPrice ? percentOff(regularPrice, price) : 0;
  return (
    <span className={`inline-flex flex-col items-start tabular ${className}`}>
      <span className="inline-flex items-baseline gap-2">
        <span className="font-semibold">
          {from && <span className="font-medium opacity-70">from </span>}
          {pct > 0 && regularPrice ? (
            <>
              <s className="mr-1.5 text-[0.7em] font-medium opacity-60" aria-label={`normally ${rupees(regularPrice)}`}>
                {rupees(regularPrice)}
              </s>
              {rupees(price)}
            </>
          ) : (
            rupees(price)
          )}
        </span>
        {durationMinutes ? <span className="text-[13px] font-medium opacity-70">{minutes(durationMinutes)}</span> : null}
      </span>
      {pct > 0 && (
        <span className="text-[12px] font-semibold text-gold-deep">
          {pct}% off{endsOn ? ` · till ${offerTill(endsOn)}` : ""}
        </span>
      )}
    </span>
  );
}
