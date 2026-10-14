/** `/services` — the full public menu (DS §6.2, T1.18). */

import type { Metadata } from "next";
import { getServices } from "@/lib/api";
import { MenuBrowser } from "@/components/menu/MenuBrowser";

export const metadata: Metadata = {
  title: "Services & prices",
  description: "The full menu at The Experts, Patiala — hair, colour, keratin, skin, threading, waxing, makeup and grooming, with the price you pay.",
  alternates: { canonical: "/services" },
};

export default async function ServicesPage() {
  const [her, him, all] = await Promise.all([getServices("her"), getServices("him"), getServices()]);
  return (
    <main className="flex-1 bg-ivory px-4 pb-28 pt-12 md:px-16 md:pb-32 md:pt-20">
      <div className="mx-auto max-w-[1240px]">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-muted md:text-[13px]">The menu</p>
        <h1 className="mt-4 font-serif text-[44px] leading-none tracking-[-0.02em] md:text-[80px]">
          Every service, every <em className="text-gold">price</em>.
        </h1>
        <p className="mt-6 max-w-[640px] text-[17px] leading-[1.6] text-ink-muted">The price shown is the price you pay at the salon.</p>
        <div className="mt-10">
          {her && him && all ? (
            <MenuBrowser her={her} him={him} all={all} />
          ) : (
            <p className="text-[16px] text-ink-muted">The menu couldn&apos;t load just now. Refresh in a minute, or message us on WhatsApp.</p>
          )}
        </div>
      </div>
    </main>
  );
}
