/** `/artists/[slug]` — one artist (DS §6.2, T1.19): profile, specialties, portfolio, "Ask for …". */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getArtists } from "@/lib/api";
import { initials } from "@/components/site/ArtistCard";
import { RequestCta } from "@/components/request/RequestContext";

const LEVEL = { senior: "Senior artist", stylist: "Stylist", junior: "Junior stylist" } as const;

export async function generateStaticParams() {
  const artists = (await getArtists()) ?? [];
  const slugs = artists.map((a) => a.slug).filter(Boolean) as string[];
  return slugs.length ? slugs.map((slug) => ({ slug })) : [{ slug: "team" }];
}

async function find(slug: string) {
  return ((await getArtists()) ?? []).find((a) => a.slug === slug) ?? null;
}

export async function generateMetadata({ params }: PageProps<"/artists/[slug]">): Promise<Metadata> {
  const a = await find((await params).slug);
  if (!a) return { title: "Artist not found" };
  return {
    title: `${a.name}${a.level ? `, ${LEVEL[a.level]}` : ""}`,
    description: a.bio || `${a.name} at The Experts, Patiala.${a.specialties.length ? ` ${a.specialties.join(", ")}.` : ""}`,
    alternates: { canonical: `/artists/${a.slug}` },
  };
}

async function Profile({ params }: { params: PageProps<"/artists/[slug]">["params"] }) {
  const a = await find((await params).slug);
  if (!a) notFound();
  const first = a.name.split(" ")[0];
  return (
    <div className="grid gap-10 md:grid-cols-[minmax(0,420px)_1fr]">
      <div className="aspect-[4/5] overflow-hidden rounded-[var(--radius-media)] bg-ivory-2">
        {a.photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={a.photo} alt={a.name} className="h-full w-full object-cover" />
        ) : (
          <div aria-hidden className="flex h-full w-full items-center justify-center font-serif text-[96px] text-ink-muted">
            {initials(a.name)}
          </div>
        )}
      </div>
      <div>
        <nav aria-label="Breadcrumb" className="text-[14px] text-ink-muted">
          <Link href="/artists" className="hover:text-ink">
            Artists
          </Link>
        </nav>
        <h1 className="mt-4 font-serif text-[44px] leading-none md:text-[72px]">{a.name}</h1>
        {(a.level || a.specialties.length > 0) && (
          <p className="mt-4 text-[17px] text-ink-muted">{[a.level ? LEVEL[a.level] : null, ...a.specialties].filter(Boolean).join(" · ")}</p>
        )}
        {a.bio && <p className="mt-6 max-w-[60ch] text-[17px] leading-[1.7]">{a.bio}</p>}
        {a.instagram && (
          <a href={`https://instagram.com/${a.instagram}`} target="_blank" rel="noopener" className="mt-4 inline-block text-[15px] font-semibold text-gold-deep hover:underline">
            @{a.instagram}
          </a>
        )}
        <div className="mt-8">
          <RequestCta preset={{ artistSlug: a.slug ?? undefined }} label={`Ask for ${first}`} />
        </div>
        {a.portfolio.length > 0 && (
          <div className="mt-12 grid grid-cols-2 gap-3 md:grid-cols-3">
            {a.portfolio.slice(0, 9).map((src) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={src} src={src} alt={`Work by ${a.name}`} loading="lazy" className="aspect-square w-full rounded-[var(--radius-card)] object-cover" />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ArtistPage(props: PageProps<"/artists/[slug]">) {
  return (
    <main className="flex-1 bg-ivory px-4 pb-28 pt-12 md:px-16 md:pb-32 md:pt-20">
      <div className="mx-auto max-w-[1240px]">
        <Suspense fallback={<div className="h-[60vh]" aria-busy="true" />}>
          <Profile params={props.params} />
        </Suspense>
      </div>
    </main>
  );
}
