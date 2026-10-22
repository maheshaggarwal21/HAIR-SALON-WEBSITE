/**
 * FAQ (DS §6.1 §12). Every answer describes how the salon actually works today — no claims the
 * owner hasn't made. Two answers depend on whether live online booking is switched on
 * (`site.onlineBooking.enabled`, CF D18, D47, D49): while it is off the site is request-only and
 * you pay at the salon; once it is on, every service books and is paid for online. Both versions
 * are written here so the page is never wrong in either state, and the fee, minimum and notice
 * period come from the same settings the booking sheet and the cancellation page use. Brands
 * named are the ones in the salon's own menu.
 */

import { slaText } from "@/lib/format";
import type { SiteInfo } from "@/lib/types";

export function faqItems(site: SiteInfo | null): [string, string][] {
  const ob = site?.onlineBooking;
  const live = ob?.enabled === true;
  const sla = slaText(site?.requestSlaMinutes ?? 120);
  const feePct = ob?.cancellationFeePercent ?? 30;
  const feeMin = ob?.cancellationFeeMin ?? 100;
  const notice = ob?.noticeHours ?? 24;

  const timeQ: [string, string] = live
    ? [
        "Is my time fixed when I book online?",
        "Yes. You choose your services, a day and a time that is free, and once you've paid it is confirmed straight away. Your WhatsApp confirmation has a link to see, move or cancel it.",
      ]
    : [
        "Does sending a request fix my time?",
        `Not yet. You choose the services, a day and a time of day. We call or WhatsApp you within ${sla} to agree the exact time, and it's fixed once we've both said yes.`,
      ];

  const payQ: [string, string] = live
    ? [
        "Do I pay online?",
        `Yes, when you book online. Pay in full, or pay a deposit of ${feePct}% of the bill (at least ₹${feeMin}) and pay the rest at the salon after your visit — cash, card or UPI.`,
      ]
    : ["Do I pay online?", "Not for now. You pay at the salon after your visit — cash, card or UPI."];

  const changeQ: [string, string] = live
    ? [
        "How do I change or cancel?",
        `Use the link in your WhatsApp confirmation, or message or call us. Moving or cancelling is free until ${notice} hours before your time, and everything you paid is refunded. Later than that, or if you don't come, we keep a booking fee of ${feePct}% of the bill (at least ₹${feeMin}) and refund the rest.`,
      ]
    : ["How do I change or cancel?", "Message or call us and we'll move or cancel it."];

  const walkInQ: [string, string] = [
    "Can I walk in?",
    live
      ? "Yes, when there's a free chair. Booking online reserves your time and your artist in advance."
      : "Yes, when there's a free chair. Sending a request means we plan your time in advance.",
  ];

  return [
    timeQ,
    payQ,
    ["Are the prices on the website final?", "Yes. The price shown is the price you pay for that service."],
    [
      "Do colour services need a patch test?",
      "Services marked “Patch test 48h before” need a quick skin test at the salon at least two days earlier, so we can check for a reaction before colouring.",
    ],
    [
      "What does “Consultation first” mean?",
      "For services with that label we talk to you first about your hair or skin and the result you want, then confirm the exact service and price before we start.",
    ],
    ["Which products do you use?", "Professional ranges — for example Lotus Professional, Brillare and Paragon facials. Ask your artist about anything specific."],
    walkInQ,
    changeQ,
  ];
}

export function Faq({ site, tone = "light" }: { site: SiteInfo | null; tone?: "light" | "dark" }) {
  return (
    <div className={`divide-y border-y ${tone === "dark" ? "divide-line-dark border-line-dark" : "divide-line border-line"}`}>
      {faqItems(site).map(([q, a]) => (
        <details key={q} className="group py-5">
          <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-4 text-[17px] font-semibold [&::-webkit-details-marker]:hidden">
            {q}
            <span aria-hidden className="text-[24px] leading-none opacity-60 transition-transform group-open:rotate-45">
              +
            </span>
          </summary>
          <p className={`mt-3 max-w-[640px] text-[16px] leading-[1.6] ${tone === "dark" ? "text-ivory-muted" : "text-ink-muted"}`}>{a}</p>
        </details>
      ))}
    </div>
  );
}
