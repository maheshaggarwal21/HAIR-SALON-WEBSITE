"use client";

/**
 * Variant selector on a service page (T1.18): pick Short / Medium / Long, see
 * its price and time, then request exactly that option.
 */

import { useState } from "react";
import type { ServiceCard as Card } from "@/lib/types";
import { Chip } from "@/components/ui/Chip";
import { PriceTag } from "@/components/ui/PriceTag";
import { RequestCta } from "@/components/request/RequestContext";

export function OptionPicker({ service }: { service: Card }) {
  const [id, setId] = useState(service.options[0]?.id);
  const opt = service.options.find((o) => o.id === id) ?? service.options[0];
  const audience = service.audience === "him" ? "him" : "her";
  return (
    <div>
      {service.options.length > 1 && (
        <div role="radiogroup" aria-label="Choose an option" className="flex flex-wrap gap-2">
          {service.options.map((o) => (
            <Chip key={o.id} role="radio" aria-checked={o.id === id} aria-pressed={undefined} selected={o.id === id} onClick={() => setId(o.id)} className="h-11 px-5">
              {o.label ?? "Option"}
            </Chip>
          ))}
        </div>
      )}
      <div className="mt-5 text-[28px]">
        <PriceTag price={opt.price} durationMinutes={opt.durationMinutes} />
      </div>
      <div className="mt-6">
        <RequestCta preset={{ audience, optionIds: [opt.id] }} label={`Request ${service.name}${opt.label ? ` (${opt.label})` : ""}`} />
      </div>
    </div>
  );
}
