/**
 * FAQ (DS §6.1 §12). Every answer describes how the salon actually works today
 * (request-lite, pay at the salon) — no claims the owner hasn't made. Brands
 * named are the ones in the salon's own menu.
 */

import { slaText } from "@/lib/format";
import type { SiteInfo } from "@/lib/types";

export function faqItems(site: SiteInfo | null): [string, string][] {
  const sla = slaText(site?.requestSlaMinutes ?? 120);
  return [
    [
      "Does sending a request fix my time?",
      `Not yet. You choose the services, a day and a time of day. We call or WhatsApp you within ${sla} to agree the exact time, and it's fixed once we've both said yes.`,
    ],
    ["Do I pay online?", "Not for now. You pay at the salon after your visit — cash, card or UPI."],
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
    ["Can I walk in?", "Yes, when there's a free chair. Sending a request means we plan your time in advance."],
    ["How do I change or cancel?", "Message or call us and we'll move or cancel it."],
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
