/**
 * FAQ (DS §6.1 §12). The answers describe online booking and online payment as the way the
 * salon works (CF D18, D47, D49): book a free time, pay in full or a deposit, cancel free until
 * the notice period. The fee, minimum and notice period come from the same settings the booking
 * sheet and the cancellation page use, so they cannot disagree with them. Brands named are the
 * ones in the salon's own menu.
 */

import type { SiteInfo } from "@/lib/types";

export function faqItems(site: SiteInfo | null): [string, string][] {
  const ob = site?.onlineBooking;
  const feePct = ob?.cancellationFeePercent ?? 30;
  const feeMin = ob?.cancellationFeeMin ?? 100;
  const notice = ob?.noticeHours ?? 24;

  const timeQ: [string, string] = [
    "Is my time fixed when I book online?",
    "Yes. You choose your services, a day and a time that is free, and once you've paid it is confirmed straight away. Your WhatsApp confirmation has a link to see, move or cancel it.",
  ];

  const payQ: [string, string] = [
    "Do I pay online?",
    `Yes, we accept online payment when you book. Pay in full, or pay a deposit of ${feePct}% of the bill (at least ₹${feeMin}) and pay the rest at the salon after your visit — cash, card or UPI.`,
  ];

  const changeQ: [string, string] = [
    "How do I change or cancel?",
    `Use the link in your WhatsApp confirmation, or message or call us. Moving or cancelling is free until ${notice} hours before your time, and everything you paid is refunded. Later than that, or if you don't come, we keep a booking fee of ${feePct}% of the bill (at least ₹${feeMin}) and refund the rest.`,
  ];

  const walkInQ: [string, string] = [
    "Can I walk in?",
    "Yes, when there's a free chair. Booking online reserves your time and your artist in advance.",
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
