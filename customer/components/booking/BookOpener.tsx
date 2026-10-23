"use client";

/**
 * Opens the booking sheet from /book's query string (DS §7). A `service`
 * slug is resolved to the option ids the sheet understands through the public
 * API; anything unknown is ignored rather than guessed.
 */

import { useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import type { ServiceCard } from "@/lib/types";
import { RequestCta, useRequest, type RequestPreset } from "@/components/request/RequestContext";

const SLUG = /^[a-z0-9-]{1,80}$/;

export function BookOpener() {
  const params = useSearchParams();
  const { open, formEnabled } = useRequest();
  const opened = useRef(false);
  const preset: RequestPreset = {};
  const aud = params.get("for");
  if (aud === "her" || aud === "him") preset.audience = aud;
  const artist = params.get("artist");
  if (artist && SLUG.test(artist)) preset.artistSlug = artist;
  const pkg = params.get("package");
  if (pkg && SLUG.test(pkg)) preset.packageSlug = pkg;
  const service = params.get("service");
  // /book?src=wa shows the unpaid WhatsApp request form instead (D62); the paid sheet stays shut.
  const waMode = params.get("src") === "wa";

  useEffect(() => {
    if (waMode || opened.current || !formEnabled) return;
    opened.current = true;
    (async () => {
      const p = { ...preset };
      if (service && SLUG.test(service)) {
        try {
          const res = await fetch(`/api/public/services/${service}`);
          if (res.ok) {
            const card = (await res.json()).service as ServiceCard;
            const option = card.options.find((o) => o.slug === service) ?? (card.options.length === 1 ? card.options[0] : null);
            if (option) p.optionIds = [option.id];
            if (!p.audience && (card.audience === "her" || card.audience === "him")) p.audience = card.audience;
          }
        } catch {
          // Open without the service; the customer picks it.
        }
      }
      open(p);
    })();
    // Runs once, on landing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formEnabled]);

  if (waMode) return null;

  return (
    <div className="mt-8">
      <RequestCta preset={preset} />
    </div>
  );
}
