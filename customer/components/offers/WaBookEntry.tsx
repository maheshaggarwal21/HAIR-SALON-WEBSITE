"use client";

/**
 * WaBookEntry — `/book?src=wa&c=<campaign>&p=<phone>&service=<slug>` (D62).
 * The unpaid WhatsApp request form: service, day and time, name and phone. The phone, the
 * campaign tag and a service are read from the link and stay editable. No payment, no code.
 * Without `src=wa` it renders nothing, so the normal /book page is exactly as it was.
 */

import { useSearchParams } from "next/navigation";
import { WaRequestForm, type WaPick } from "@/components/offers/WaRequestForm";
import type { SiteInfo } from "@/lib/types";

const SLUG = /^[a-z0-9-]{1,80}$/;

export function WaBookEntry({ site, menu }: { site: SiteInfo; menu: (WaPick & { slug: string | null })[] }) {
  const params = useSearchParams();
  if (params.get("src") !== "wa") return null;
  const service = params.get("service");
  const match = service && SLUG.test(service) ? menu.find((m) => m.slug === service) : undefined;
  return (
    <div className="mt-8">
      <WaRequestForm
        site={site}
        menu={menu.map(({ id, name }) => ({ id, name }))}
        initialServiceIds={match ? [match.id] : []}
        initialPhone={params.get("p") ?? ""}
      />
    </div>
  );
}
