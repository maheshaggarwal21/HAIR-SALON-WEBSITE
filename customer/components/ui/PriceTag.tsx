/**
 * PriceTag — DESIGN.md §5. "₹500" or "from ₹500", with the duration beside it
 * when one is known.
 *
 * Prices are the real price paid (Service.publicPrice). There is deliberately
 * no strike-through prop: a "was" price is allowed only for a time-boxed
 * Campaign with real start/end dates (CLAUDE.md, "Prices shown to customers"),
 * and campaigns arrive in Phase 3 with their own component.
 */

import { minutes, rupees } from "@/lib/format";

export function PriceTag({
  price,
  from = false,
  durationMinutes,
  className = "",
}: {
  price: number;
  from?: boolean;
  durationMinutes?: number | null;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-baseline gap-2 tabular ${className}`}>
      <span className="font-semibold">
        {from && <span className="font-medium opacity-70">from </span>}
        {rupees(price)}
      </span>
      {durationMinutes ? <span className="text-[13px] font-medium opacity-70">{minutes(durationMinutes)}</span> : null}
    </span>
  );
}
