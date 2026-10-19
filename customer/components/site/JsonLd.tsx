/**
 * Structured data (DS §6.2 SEO, T1.22): HairSalon on the home page, Service on
 * service pages. Built only from real data. No aggregateRating: Google treats
 * a business's own rating markup as self-serving and won't show it, and the
 * live rating is already on the page with attribution.
 */

import type { ServiceCard, SiteInfo } from "@/lib/types";
import { SITE_URL } from "@/lib/site";

// The salon's pin from the owner's Google Maps link (19 Oct 2026).
const GEO = { latitude: 30.366743, longitude: 76.402412 };
const DAY_SCHEMA = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" } as const;

function Script({ data }: { data: object }) {
  // `<` escaped so a service name can never close the script tag.
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }} />;
}

export function SalonJsonLd({ site }: { site: SiteInfo }) {
  const c = site.contact;
  return (
    <Script
      data={{
        "@context": "https://schema.org",
        "@type": "HairSalon",
        "@id": `${SITE_URL}/#salon`,
        name: "The Experts",
        url: SITE_URL,
        telephone: c.phone ? `+91${c.phone}` : undefined,
        address: c.address
          ? { "@type": "PostalAddress", streetAddress: c.address.replace(/,\s*Patiala$/, ""), addressLocality: "Patiala", addressRegion: "Punjab", addressCountry: "IN" }
          : undefined,
        geo: { "@type": "GeoCoordinates", ...GEO },
        hasMap: c.mapUrl ?? undefined,
        sameAs: c.instagram ? [`https://instagram.com/${c.instagram}`] : undefined,
        priceRange: "₹₹",
        openingHoursSpecification: (Object.keys(DAY_SCHEMA) as (keyof typeof DAY_SCHEMA)[]).flatMap((d) =>
          (site.openingHours[d] || []).map((i) => ({ "@type": "OpeningHoursSpecification", dayOfWeek: DAY_SCHEMA[d], opens: i.open, closes: i.close }))
        ),
      }}
    />
  );
}

export function ServiceJsonLd({ service }: { service: ServiceCard }) {
  return (
    <Script
      data={{
        "@context": "https://schema.org",
        "@type": "Service",
        name: service.name,
        description: service.shortDescription ?? undefined,
        serviceType: service.displayCategory ?? undefined,
        provider: { "@id": `${SITE_URL}/#salon` },
        areaServed: "Patiala",
        offers: service.options.map((o) => ({
          "@type": "Offer",
          name: o.label ? `${service.name} — ${o.label}` : service.name,
          price: o.price,
          priceCurrency: "INR",
          url: `${SITE_URL}/services/${service.slug}`,
        })),
      }}
    />
  );
}
