/**
 * Site header. Server component; the mobile menu is a <details> element, so it
 * opens and closes with no JavaScript at all. One primary CTA (the request
 * sheet) — the only gold button in the header (DS §3.1). "Staff sign in" is a
 * quiet text link to the staff app (T1.23), labelled "Staff" so customers
 * don't think they need an account to book.
 */

import Link from "next/link";
import { RequestCta } from "@/components/request/RequestContext";
import { STAFF_SIGNIN_URL } from "@/lib/site";

const NAV = [
  { href: "/services", label: "Services" },
  { href: "/services?for=her", label: "For her" },
  { href: "/services?for=him", label: "For him" },
  { href: "/artists", label: "Artists" },
  { href: "/#visit", label: "Visit" },
];

export function Header() {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-ivory/95 text-ink backdrop-blur">
      <div className="mx-auto flex h-16 max-w-[1240px] items-center justify-between gap-4 px-4 md:px-8">
        <Link href="/" className="font-serif text-[26px] leading-none" aria-label="The Experts, home">
          The Experts
        </Link>

        <nav aria-label="Main" className="hidden items-center gap-7 text-[15px] font-medium md:flex">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="text-ink-muted transition-colors hover:text-ink">
              {n.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <a
            href={STAFF_SIGNIN_URL}
            rel="nofollow"
            className="hidden px-3 text-[14px] font-medium text-ink-muted transition-colors hover:text-ink lg:inline"
          >
            Staff sign in
          </a>
          <div className="hidden md:block">
            <RequestCta label="Request a slot" className="h-11! md:h-11!" />
          </div>
          <details className="group relative md:hidden">
            <summary
              className="flex h-11 w-11 cursor-pointer list-none items-center justify-center rounded-full border border-line [&::-webkit-details-marker]:hidden"
              aria-label="Menu"
            >
              <span aria-hidden className="text-[20px] leading-none group-open:hidden">☰</span>
              <span aria-hidden className="hidden text-[22px] leading-none group-open:inline">×</span>
            </summary>
            <nav
              aria-label="Main"
              className="absolute right-0 top-14 w-56 rounded-[var(--radius-card)] border border-line bg-ivory p-2 shadow-[var(--shadow-sheet)]"
            >
              {NAV.map((n) => (
                <Link key={n.href} href={n.href} className="block rounded-[var(--radius-control)] px-4 py-3 text-[16px] hover:bg-ivory-2">
                  {n.label}
                </Link>
              ))}
              <a
                href={STAFF_SIGNIN_URL}
                rel="nofollow"
                className="mt-1 block rounded-[var(--radius-control)] border-t border-line px-4 py-3 text-[15px] text-ink-muted hover:bg-ivory-2"
              >
                Staff sign in
              </a>
            </nav>
          </details>
        </div>
      </div>
    </header>
  );
}
