/** Site footer (ink): address, hours, contact, Instagram, legal pages. */

import Link from "next/link";
import type { SiteInfo } from "@/lib/types";
import { hoursSummary, phoneLabel } from "@/lib/format";
import { STAFF_SIGNIN_URL } from "@/lib/site";

export function Footer({ site }: { site: SiteInfo | null }) {
  const c = site?.contact;
  return (
    <footer className="bg-ink px-4 pb-28 pt-16 text-ivory-muted md:px-16 md:pb-16">
      <div className="mx-auto grid max-w-[1240px] gap-10 md:grid-cols-[1.4fr_1fr_1fr]">
        <div>
          <div className="font-serif text-[34px] leading-none text-ivory">The Experts</div>
          <p className="mt-3 max-w-[36ch] text-[15px] leading-[1.6]">Hair, colour, skin and bridal in Patiala.</p>
          {c?.address && <p className="mt-4 max-w-[40ch] text-[15px] leading-[1.6] text-ivory">{c.address}</p>}
        </div>
        {site && (
          <div>
            <h2 className="text-[12px] font-semibold uppercase tracking-[0.18em]">Hours</h2>
            <dl className="mt-3 space-y-1 text-[14px]">
              {hoursSummary(site).map((g) => (
                <div key={g.days} className="flex justify-between gap-4">
                  <dt>{g.days}</dt>
                  <dd className="tabular text-ivory">{g.text}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
        <div className="space-y-2 text-[15px]">
          <h2 className="text-[12px] font-semibold uppercase tracking-[0.18em]">Contact</h2>
          {c?.phone && (
            <a className="block text-ivory hover:underline" href={`tel:+91${c.phone}`}>
              {phoneLabel(c.phone)}
            </a>
          )}
          {c?.whatsapp && (
            <a className="block hover:text-ivory" href={`https://wa.me/91${c.whatsapp}`} target="_blank" rel="noopener">
              WhatsApp
            </a>
          )}
          {c?.mapUrl && (
            <a className="block hover:text-ivory" href={c.mapUrl} target="_blank" rel="noopener">
              Directions
            </a>
          )}
          {c?.instagram && (
            <a className="block hover:text-ivory" href={`https://instagram.com/${c.instagram}`} target="_blank" rel="noopener">
              @{c.instagram}
            </a>
          )}
        </div>
      </div>
      <div className="mx-auto mt-12 flex max-w-[1240px] flex-wrap gap-x-6 gap-y-2 border-t border-line-dark pt-6 text-[13px]">
        <Link href="/privacy" className="hover:text-ivory">Privacy</Link>
        <Link href="/terms" className="hover:text-ivory">Terms</Link>
        <Link href="/cancellation-policy" className="hover:text-ivory">Cancellation policy</Link>
        <a href={STAFF_SIGNIN_URL} rel="nofollow" className="hover:text-ivory">Staff sign in</a>
        <span className="ml-auto">The Experts, Patiala</span>
      </div>
    </footer>
  );
}
