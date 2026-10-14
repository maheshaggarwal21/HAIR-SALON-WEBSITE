/**
 * `/services/[slug]` — one service (DS §6.2, T1.18): what it is, price and
 * options, duration (when confirmed), badges, FAQ, "Request this". The SEO page
 * for searches like "keratin treatment in Patiala" (Service JSON-LD).
 *
 * Every menu card is prerendered at build (generateStaticParams). A card added
 * later renders on first visit and is then cached (ISR with Cache Components).
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getService, getServices, getSite } from "@/lib/api";
import { OptionPicker } from "@/components/menu/OptionPicker";
import { Faq } from "@/components/site/Faq";
import { ServiceJsonLd } from "@/components/site/JsonLd";
import { getServiceImage } from "@/lib/serviceImages";

/** Cache Components needs at least one param; "menu" is a stand-in that 404s. */
export async function generateStaticParams() {
  const [her, him] = await Promise.all([getServices("her"), getServices("him")]);
  const slugs = [...new Set([...(her ?? []), ...(him ?? [])].map((c) => c.slug))];
  return slugs.length ? slugs.map((slug) => ({ slug })) : [{ slug: "menu" }];
}

export async function generateMetadata({ params }: PageProps<"/services/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const s = await getService(slug);
  if (!s) return { title: "Service not found" };
  const title = s.seo?.title || `${s.name} in Patiala`;
  const description =
    s.seo?.description ||
    s.shortDescription ||
    `${s.name} at The Experts, Sirhind–Patiala Rd, Patiala. ${s.options.length > 1 ? "From" : "Price"} ₹${s.fromPrice.toLocaleString("en-IN")}.`;
  return { title, description, alternates: { canonical: `/services/${s.slug}` } };
}

async function ServiceDetail({ params }: { params: PageProps<"/services/[slug]">["params"] }) {
  const { slug } = await params;
  const [service, site] = await Promise.all([getService(slug), getSite()]);
  if (!service) notFound();
  const photo = getServiceImage(service);

  return (
    <>
      <ServiceJsonLd service={service} />
      <nav aria-label="Breadcrumb" className="text-[14px] text-ink-muted">
        <Link href="/services" className="hover:text-ink">
          Services
        </Link>
        {service.displayCategory && <> · {service.displayCategory}</>}
      </nav>
      <h1 className="mt-4 font-serif text-[44px] leading-none tracking-[-0.02em] md:text-[80px]">{service.name}</h1>
      {service.shortDescription && <p className="mt-6 max-w-[640px] text-[19px] leading-[1.6]">{service.shortDescription}</p>}

      {(service.requiresConsultation || service.requiresPatchTest) && (
        <div className="mt-6 flex flex-wrap gap-2">
          {service.requiresConsultation && (
            <span className="rounded-full bg-sand px-3 py-1 text-[13px] font-semibold text-gold-deep">Consultation first</span>
          )}
          {service.requiresPatchTest && (
            <span className="rounded-full bg-sand px-3 py-1 text-[13px] font-semibold text-gold-deep">Patch test 48h before</span>
          )}
        </div>
      )}

      <div className="mt-10 grid gap-12 md:grid-cols-[1fr_1fr]">
        <div className="rounded-[var(--radius-card)] border border-line bg-ivory-2 p-6 md:p-8">
          <OptionPicker service={service} />
          <p className="mt-6 text-[14px] text-ink-muted">You pay at the salon. We call or WhatsApp you to fix the exact time.</p>
        </div>
        <div className="md:order-first">
          {/* The large photo (1200px) on desktop; phones get the 640px file. */}
          <div className="aspect-[3/2] overflow-hidden rounded-[var(--radius-card)] bg-ivory-2">
            {/* eslint-disable-next-line @next/next/no-img-element -- static WebP with our own srcset */}
            <img
              src={photo.src}
              srcSet={photo.srcSet}
              sizes={photo.srcSet ? "(min-width: 1024px) 600px, 213px" : undefined}
              alt={photo.alt}
              width={1200}
              height={800}
              decoding="async"
              className="h-full w-full object-cover"
            />
          </div>
          {service.description && (
            <div className="mt-8 max-w-[640px] whitespace-pre-line text-[17px] leading-[1.7]">{service.description}</div>
          )}
        </div>
      </div>

      <section className="mt-20 max-w-[840px]">
        <h2 className="font-serif text-[34px] leading-[1.05] md:text-[48px]">
          Good to <em className="text-gold">know</em>.
        </h2>
        <div className="mt-8">
          <Faq site={site} />
        </div>
      </section>
    </>
  );
}

export default function ServicePage(props: PageProps<"/services/[slug]">) {
  return (
    <main className="flex-1 bg-ivory px-4 pb-28 pt-12 md:px-16 md:pb-32 md:pt-20">
      <div className="mx-auto max-w-[1240px]">
        <Suspense fallback={<div className="h-[60vh]" aria-busy="true" />}>
          <ServiceDetail params={props.params} />
        </Suspense>
      </div>
    </main>
  );
}
