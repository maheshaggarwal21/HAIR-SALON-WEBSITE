/**
 * /offers/karva-chauth — Phase 1 ad landing page (T1.13, DS §6.2 `/offers/[campaign]`).
 *
 * One job: turn a visitor from an Instagram ad into a REQUEST the salon can
 * call back. Fast (no images until the shoot, T0.10; no motion libraries),
 * one primary CTA, honest copy: nothing here says "booked", no invented offers,
 * ratings or countdowns. Every price comes from the API and is what the
 * customer pays.
 *
 * Section rhythm (DS §3.1): ink hero → ivory menu → blush how-it-works →
 * ink visit → ivory FAQ → ink footer (root layout).
 *
 * Data: all reads are cached (`lib/api.ts`), so in normal operation the whole
 * page is part of the prerendered shell. If the API is unreachable, the
 * Suspense fallback is the static hero, and any section without data is
 * hidden rather than faked.
 */

import type { Metadata } from "next";
import { Suspense } from "react";
import { getPackages, getServices, getSite } from "@/lib/api";
import { hoursSummary, phoneLabel, rupees, slaText, whatsappHref } from "@/lib/format";
import type { ServiceCard as Card, SiteInfo } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { ServiceCard } from "@/components/ui/ServiceCard";
import { RequestCta } from "@/components/request/RequestContext";

export const metadata: Metadata = {
  title: "Karva Chauth at The Experts, Patiala",
  description:
    "Hair, skin and make-up for Karva Chauth at The Experts, Sirhind–Patiala Rd. Choose your services and a time of day — we'll call to fix your slot.",
};

const MENU_LIMIT = 8;

export default function KarvaChauthPage() {
  return (
    <Suspense fallback={<Hero />}>
      <Offer />
    </Suspense>
  );
}

async function Offer() {
  // The request sheet, sticky bar and footer come from the root layout.
  const [site, her, packages] = await Promise.all([getSite(), getServices("her"), getPackages()]);
  const highlights = pickHighlights(her ?? []);
  const livePackages = packages ?? [];

  return (
      <main className="flex-1 pb-24 md:pb-0">
        <Hero site={site} withActions />

        {(livePackages.length > 0 || highlights.length > 0) && (
          <section className="bg-ivory px-4 py-16 md:px-16 md:py-32">
            <div className="mx-auto max-w-site">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-muted md:text-[13px]">For the evening</p>
              <h2 className="mt-4 max-w-[18ch] font-serif text-[34px] leading-[1.05] md:text-[56px]">
                Pick what you <em className="text-gold">love</em>.
              </h2>
              <p className="mt-4 max-w-[640px] text-[15px] leading-[1.6] text-ink-muted md:text-[16px]">
                Prices are what you pay at the salon. Tap request and add as many as you like.
              </p>

              {livePackages.length > 0 && (
                <div className="mt-10 grid gap-4 md:grid-cols-2">
                  {livePackages.map((p) => {
                    // The real sum of the items' website prices, never an invented "was" price.
                    const separately = p.items.reduce((sum, i) => sum + i.price, 0);
                    return (
                    <div key={p.slug} className="rounded-[var(--radius-card)] border border-line bg-ivory-2 p-6">
                      <div className="flex items-start justify-between gap-4">
                        <h3 className="font-serif text-[28px] leading-tight md:text-[32px]">{p.name}</h3>
                        <div className="text-right">
                          <span className="tabular text-[20px] font-semibold">{rupees(p.price)}</span>
                          {separately > p.price && (
                            <div className="tabular text-[13px] text-ink-muted">{rupees(separately)} if booked separately</div>
                          )}
                        </div>
                      </div>
                      {p.description && <p className="mt-2 text-[15px] leading-[1.6] text-ink-muted">{p.description}</p>}
                      <ul className="mt-4 space-y-1 text-[15px]">
                        {p.items.map((i) => (
                          <li key={i.id}>· {i.name}</li>
                        ))}
                      </ul>
                      <div className="mt-6">
                        <RequestCta
                          preset={{ audience: p.audience === "him" ? "him" : "her", packageSlug: p.slug }}
                          label="Request this package"
                          variant="secondary"
                        />
                      </div>
                    </div>
                    );
                  })}
                </div>
              )}

              {highlights.length > 0 && (
                <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {highlights.map((c) => (
                    <div key={c.slug} className="flex flex-col">
                      <ServiceCard service={c} showImage fill />
                      <div className="mt-2">
                        <RequestCta
                          preset={{ audience: "her", optionIds: c.options.length === 1 ? [c.options[0].id] : [] }}
                          label="Request"
                          variant="secondary"
                          className="w-full"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}

        <HowItWorks slaMinutes={site?.requestSlaMinutes ?? 120} />
        {site && <VisitUs site={site} />}
        <Faq site={site} />
      </main>

  );
}

/** Featured first, then the owner's order; only services that can be requested online. */
function pickHighlights(cards: Card[]) {
  return cards
    .filter((c) => c.options.some((o) => o.bookingMode !== "walkin_only"))
    .sort((a, b) => Number(b.featured) - Number(a.featured) || a.sortOrder - b.sortOrder)
    .slice(0, MENU_LIMIT);
}

// ── Sections ─────────────────────────────────────────────────────────────────

function Hero({ site, withActions = false }: { site?: SiteInfo | null; withActions?: boolean }) {
  const whatsapp = whatsappHref(site?.contact.whatsapp, "Hi, I'd like to ask about Karva Chauth appointments.");
  return (
    <section className="bg-ivory-2 px-4 pb-16 pt-20 md:px-16 md:pb-32 md:pt-36">
      <div className="mx-auto max-w-site">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-muted md:text-[13px]">
          Karva Chauth · The Experts, Patiala
        </p>
        <h1 className="mt-6 max-w-[12ch] font-serif text-[44px] leading-none tracking-[-0.02em] md:text-[84px]">
          Karva Chauth, <em className="text-gold">sorted</em>.
        </h1>
        <p className="mt-8 max-w-[640px] text-[17px] leading-[1.6] text-ink-muted md:text-[19px]">
          Hair, skin and make-up for your evening. Choose what you&apos;d like and a time of day — we&apos;ll call you to
          fix the exact slot.
        </p>
        {withActions && (
          <>
            <div id="hero-cta" className="mt-10 flex flex-wrap gap-3">
              <RequestCta />
              {whatsapp && (
                <Button variant="whatsapp" href={whatsapp} target="_blank" rel="noopener">
                  WhatsApp us
                </Button>
              )}
            </div>
            <p className="mt-4 text-[13px] font-medium text-ink-muted">No payment now. You pay at the salon after your visit.</p>
          </>
        )}
      </div>
    </section>
  );
}

function HowItWorks({ slaMinutes }: { slaMinutes: number }) {
  const steps = [
    ["Choose", "Pick your services. Prices are the final price."],
    ["Pick a time of day", "Morning, afternoon or evening, on the day you want."],
    ["We call you", `Within ${slaText(slaMinutes)} we call or WhatsApp to agree the exact time.`],
  ];
  return (
    <section className="bg-sand px-4 py-16 md:px-16 md:py-32">
      <div className="mx-auto max-w-site">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gold-deep md:text-[13px]">How it works</p>
        <h2 className="mt-4 font-serif text-[34px] leading-[1.05] md:text-[56px]">
          Three steps, <em className="text-gold-deep">no fuss</em>.
        </h2>
        <ol className="mt-10 grid gap-6 md:grid-cols-3">
          {steps.map(([title, body], i) => (
            <li key={title} className="rounded-[var(--radius-card)] bg-ivory p-6">
              <span className="tabular font-serif text-[40px] leading-none text-gold-deep">{i + 1}</span>
              <h3 className="mt-3 text-[17px] font-semibold">{title}</h3>
              <p className="mt-1 text-[15px] leading-[1.6] text-ink-muted">{body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function VisitUs({ site }: { site: SiteInfo }) {
  const { address, mapUrl, phone } = site.contact;
  return (
    <section className="bg-ivory-2 px-4 py-16 md:px-16 md:py-32">
      <div className="mx-auto grid max-w-site gap-10 md:grid-cols-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-muted md:text-[13px]">Visit us</p>
          <h2 className="mt-4 font-serif text-[34px] leading-[1.05] md:text-[56px]">
            Find us <em className="text-gold">easily</em>.
          </h2>
          {address && <p className="mt-6 text-[17px] leading-[1.6] md:text-[19px]">{address}</p>}
          <div className="mt-8 flex flex-wrap gap-3">
            {mapUrl && (
              <Button variant="secondary" href={mapUrl} target="_blank" rel="noopener">
                Directions
              </Button>
            )}
            {phone && (
              <Button variant="ghost" href={`tel:+91${phone}`}>
                Call {phoneLabel(phone)}
              </Button>
            )}
          </div>
        </div>
        <div>
          <h3 className="text-[13px] font-semibold uppercase tracking-[0.18em] text-ink-muted">Opening hours</h3>
          <dl className="mt-4 space-y-2 text-[16px]">
            {hoursSummary(site).map((g) => (
              <div key={g.days} className="flex justify-between gap-6 border-b border-line pb-2">
                <dt>{g.days}</dt>
                <dd className="tabular text-ink-muted">{g.text}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}

function Faq({ site }: { site: SiteInfo | null }) {
  const sla = slaText(site?.requestSlaMinutes ?? 120);
  const items: [string, string][] = [
    [
      "Does sending the form fix my time?",
      `Not yet. The form sends a request. We call or WhatsApp you within ${sla} to agree an exact time, and it's fixed once we've both said yes.`,
    ],
    ["Do I pay anything now?", "No. You pay at the salon after your visit — cash, card or UPI."],
    ["Are the prices final?", "Yes. The price shown is the price you pay for that service."],
    [
      "Can I change or cancel?",
      site?.contact.whatsapp || site?.contact.phone
        ? "Of course. Message or call us and we'll move or cancel it."
        : "Of course. Get in touch and we'll move or cancel it.",
    ],
    ["Can I bring someone along?", "Yes. Send one request per person, or tell us in the note and we'll plan it together."],
  ];
  return (
    <section className="bg-ivory px-4 py-16 md:px-16 md:py-32">
      {/* Same layout as the home page FAQ: title left, questions right, one content column. */}
      <div className="mx-auto grid max-w-site gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-16">
        <div className="lg:sticky lg:top-28 lg:self-start">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-muted md:text-[13px]">Questions</p>
          <h2 className="mt-4 font-serif text-[34px] leading-[1.05] md:text-[56px]">
            Good to <em className="text-gold">know</em>.
          </h2>
          <div className="mt-8 hidden lg:block">
            <RequestCta />
          </div>
        </div>
        <div>
          <div className="divide-y divide-line border-y border-line">
            {items.map(([q, a]) => (
              <details key={q} className="group py-5">
                <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-4 text-[17px] font-semibold">
                  {q}
                  <span aria-hidden className="text-[24px] leading-none text-ink-muted transition-transform group-open:rotate-45">
                    +
                  </span>
                </summary>
                <p className="mt-3 max-w-[640px] text-[16px] leading-[1.6] text-ink-muted">{a}</p>
              </details>
            ))}
          </div>
          <div className="mt-12 lg:hidden">
            <RequestCta />
          </div>
        </div>
      </div>
    </section>
  );
}
