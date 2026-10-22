"use client";

/**
 * Option selector on a service page (T1.18, D34): pick one option from an
 * ordered dropdown (each with its price), see its price and time, then request
 * exactly that option.
 */

import { useState } from "react";
import type { ServiceCard as Card } from "@/lib/types";
import { OptionSelect } from "@/components/ui/OptionSelect";
import { PriceTag } from "@/components/ui/PriceTag";
import { RequestCta } from "@/components/request/RequestContext";

export function OptionPicker({ service }: { service: Card }) {
  const [id, setId] = useState(service.options[0]?.id);
  const opt = service.options.find((o) => o.id === id) ?? service.options[0];
  const audience = service.audience === "him" ? "him" : "her";
  return (
    <div>
      {service.options.length > 1 && (
        <>
          <p className="mb-2 text-[13px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
            {service.options.length} options
          </p>
          <OptionSelect size="lg" label={`${service.name}: choose an option`} options={service.options} value={opt ? [opt.id] : []} onChange={(ids) => setId(ids[0])} />
        </>
      )}
      <div className="mt-5 text-[28px]">
        <PriceTag price={opt.price} durationMinutes={opt.durationMinutes} regularPrice={opt.regularPrice} endsOn={opt.offerEndsOn} />
      </div>
      <div className="mt-6">
        <RequestCta preset={{ audience, optionIds: [opt.id] }} label={`Request ${service.name}${opt.label ? ` (${opt.label})` : ""}`} />
      </div>
    </div>
  );
}
