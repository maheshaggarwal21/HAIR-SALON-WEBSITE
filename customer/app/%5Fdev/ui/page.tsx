/**
 * /_dev/ui — visual check page for the base components (T1.12). The folder is
 * `%5Fdev` because a plain `_dev` folder is private in the App Router and
 * would never route.
 *
 * Development only: production builds answer 404, so the sample data below can
 * never be mistaken for the real menu.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { PriceTag } from "@/components/ui/PriceTag";
import { ServiceCard } from "@/components/ui/ServiceCard";
import type { ServiceCard as Card } from "@/lib/types";

export const metadata: Metadata = { title: "UI check (dev only)", robots: { index: false, follow: false } };

const SAMPLE_SINGLE: Card = {
  slug: "sample-facial",
  name: "Sample facial",
  displayCategory: "Skin",
  audience: "her",
  shortDescription: "Sample text — dev page only.",
  images: [],
  featured: false,
  sortOrder: 0,
  requiresConsultation: false,
  requiresPatchTest: false,
  fromPrice: 1500,
  fromRegularPrice: null,
  offerEndsOn: null,
  options: [{ id: "a", slug: "sample-facial", label: null, price: 1500, regularPrice: null, offerEndsOn: null, durationMinutes: 60, bookingMode: "request" }],
};

const SAMPLE_VARIANTS: Card = {
  ...SAMPLE_SINGLE,
  slug: "sample-smoothening",
  name: "Sample smoothening",
  shortDescription: "Variants render as option chips.",
  requiresConsultation: true,
  requiresPatchTest: true,
  fromPrice: 3000,
  fromRegularPrice: null,
  offerEndsOn: null,
  options: [
    { id: "s", slug: "s", label: "Short", price: 3000, regularPrice: null, offerEndsOn: null, durationMinutes: null, bookingMode: "request" },
    { id: "m", slug: "m", label: "Medium", price: 4000, regularPrice: null, offerEndsOn: null, durationMinutes: null, bookingMode: "request" },
    { id: "l", slug: "l", label: "Long", price: 5000, regularPrice: null, offerEndsOn: null, durationMinutes: null, bookingMode: "request" },
  ],
};

/** An offer is running: the normal price crossed out, the price paid, "% off · till" below (D59). */
const SAMPLE_OFFER: Card = {
  ...SAMPLE_SINGLE,
  slug: "sample-offer",
  name: "Sample on offer",
  fromPrice: 400,
  fromRegularPrice: 500,
  offerEndsOn: "2026-10-31",
  options: [{ id: "o", slug: "sample-offer", label: null, price: 400, regularPrice: 500, offerEndsOn: "2026-10-31", durationMinutes: 45, bookingMode: "request" }],
};

export default function DevUiPage() {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <main className="flex-1">
      <section className="bg-ivory px-4 py-12 md:px-16">
        <h1 className="font-serif text-[44px] leading-none">
          Components on <em className="text-gold">ivory</em>.
        </h1>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="whatsapp" href="#">
            WhatsApp
          </Button>
          <Button disabled>Disabled</Button>
        </div>
        <div className="mt-6 flex flex-wrap gap-2">
          <Chip>Hair</Chip>
          <Chip selected>Colour</Chip>
          <Chip>Skin</Chip>
        </div>
        <div className="mt-6 flex flex-wrap gap-6 text-[17px]">
          <PriceTag price={500} />
          <PriceTag price={500} from />
          <PriceTag price={1500} durationMinutes={45} />
          <PriceTag price={4500} durationMinutes={150} />
        </div>
        <div className="mt-8 grid max-w-[900px] gap-4 md:grid-cols-2">
          <ServiceCard service={SAMPLE_SINGLE} />
          <ServiceCard service={SAMPLE_OFFER} />
          <ServiceCard service={SAMPLE_VARIANTS} />
        </div>
      </section>
      <section className="bg-ink px-4 py-12 text-ivory md:px-16">
        <h2 className="font-serif text-[34px] leading-none">
          And on <em className="text-gold">ink</em>.
        </h2>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button tone="dark">Primary</Button>
          <Button variant="secondary" tone="dark">
            Secondary
          </Button>
          <Button variant="whatsapp" tone="dark" href="#">
            WhatsApp
          </Button>
        </div>
        <div className="mt-6 flex flex-wrap gap-2">
          <Chip tone="dark">Hair</Chip>
          <Chip tone="dark" selected>
            Colour
          </Chip>
        </div>
        <div className="mt-8 grid max-w-[900px] gap-4 md:grid-cols-2">
          <ServiceCard service={SAMPLE_SINGLE} tone="dark" />
          <ServiceCard service={SAMPLE_VARIANTS} tone="dark" />
        </div>
      </section>
    </main>
  );
}
