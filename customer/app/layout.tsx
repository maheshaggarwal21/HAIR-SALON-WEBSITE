import type { Metadata, Viewport } from "next";
import { Instrument_Serif, Manrope } from "next/font/google";
import "./globals.css";
import { getArtists, getCampaigns, getPackages, getServices, getSite } from "@/lib/api";
import { SITE_URL, INDEXABLE } from "@/lib/site";
import { UtmCapture } from "@/components/UtmCapture";
import { MetaPixel } from "@/components/analytics/MetaPixel";
import { RequestProvider } from "@/components/request/RequestContext";
import { RequestSheet } from "@/components/request/RequestSheet";
import { BookingSheet } from "@/components/request/BookingSheet";
import { StickyMobileBar } from "@/components/StickyMobileBar";
import { Header } from "@/components/site/Header";
import { OfferBar } from "@/components/offers/OfferBar";
import { OfferPopup } from "@/components/offers/OfferPopup";
import { Footer } from "@/components/site/Footer";
import { RevealObserver } from "@/components/motion/Reveal";

// DESIGN.md §3.2 and §9: two families, self-hosted by next/font, latin subset,
// display swap. Instrument Serif ships one weight (400) in roman and italic —
// the italic carries the single accent word in every headline.
const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  display: "swap",
});

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: "The Experts — Hair & Beauty Salon, Patiala", template: "%s · The Experts, Patiala" },
  description:
    "Hair, colour, keratin, skin, makeup and grooming at The Experts, Sirhind–Patiala Rd, Patiala. See real prices and request your appointment online.",
  // Indexed only on the real domain at launch (T1.22/T1.23). Previews and the
  // old placeholder stay out of Google so an unfinished page is never the result.
  robots: INDEXABLE ? { index: true, follow: true } : { index: false, follow: false },
  openGraph: { type: "website", siteName: "The Experts", locale: "en_IN" },
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
};

/**
 * Arms the CSS motion system before first paint: `.motion-ok` on <html> lets
 * `.reveal` sections start hidden and fade in. Skipped for reduced motion, and
 * absent without JS — so the prerendered page is always fully visible.
 */
const MOTION_BOOT = `try{if(!matchMedia('(prefers-reduced-motion: reduce)').matches)document.documentElement.classList.add('motion-ok')}catch(e){}`;

/**
 * Every page shares the header, footer, request sheet and sticky mobile bar.
 * The site data comes from cached reads (lib/api.ts), so this is part of the
 * prerendered shell; when the API is unreachable the reads return null and
 * the request form simply stays off (CTAs fall back to WhatsApp).
 */
export default async function RootLayout({ children }: LayoutProps<"/">) {
  const [site, her, him, artists, packages, campaigns] = await Promise.all([
    getSite(),
    getServices("her"),
    getServices("him"),
    getArtists(),
    getPackages(),
    getCampaigns(),
  ]);
  const formAvailable = Boolean(site && her && him && (her.length || him.length));
  // Phase 2 (T2.22): live booking once an artist is online and payments work.
  const bookingEnabled = Boolean(formAvailable && site?.onlineBooking?.enabled);

  return (
    <html lang="en-IN" className={`${instrumentSerif.variable} ${manrope.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: MOTION_BOOT }} />
      </head>
      <body className="flex min-h-full flex-col bg-ivory">
        <RequestProvider whatsappNumber={site?.contact.whatsapp ?? null} formAvailable={formAvailable} bookingEnabled={bookingEnabled}>
          {/* Live offer (CF D29): colourful bar above the header on every page, and a pop-up. */}
          <OfferBar data={campaigns} />
          <Header />
          <div className="flex flex-1 flex-col">{children}</div>
          <Footer site={site} />
          {site && formAvailable && !bookingEnabled && (
            <RequestSheet site={site} services={{ her: her ?? [], him: him ?? [] }} artists={artists ?? []} packages={packages ?? []} />
          )}
          {site && bookingEnabled && (
            <BookingSheet site={site} services={{ her: her ?? [], him: him ?? [] }} artists={artists ?? []} packages={packages ?? []} />
          )}
          <StickyMobileBar mapUrl={site?.contact.mapUrl ?? null} watchId="hero-cta" />
          <OfferPopup data={campaigns} />
        </RequestProvider>
        <UtmCapture />
        <MetaPixel />
        <RevealObserver />
      </body>
    </html>
  );
}
