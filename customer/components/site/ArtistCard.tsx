/**
 * ArtistCard (DS §5): photo 4:5 (or the artist's initials until the shoot),
 * name, level, two specialties, Instagram handle, and "Ask for {name}" (request wording in Phase 1; DS calls it "Book with").
 */

import Link from "next/link";
import type { PublicArtist } from "@/lib/types";
import { RequestCta } from "@/components/request/RequestContext";

const LEVEL = { senior: "Senior artist", stylist: "Stylist", junior: "Junior stylist" } as const;

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

export function ArtistCard({ artist }: { artist: PublicArtist }) {
  const first = artist.name.split(" ")[0];
  return (
    <article className="flex flex-col">
      <Link href={`/artists/${artist.slug}`} className="group block">
        <div className="aspect-[4/5] overflow-hidden rounded-[var(--radius-media)] bg-ivory-2">
          {artist.photo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={artist.photo} alt={artist.name} loading="lazy" className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
          ) : (
            <div aria-hidden className="flex h-full w-full items-center justify-center font-serif text-[64px] text-ink-muted">
              {initials(artist.name)}
            </div>
          )}
        </div>
        <h3 className="mt-4 font-serif text-[26px] leading-tight">{artist.name}</h3>
      </Link>
      <p className="text-[14px] text-ink-muted">
        {[artist.level ? LEVEL[artist.level] : null, ...artist.specialties.slice(0, 2)].filter(Boolean).join(" · ") || " "}
      </p>
      {artist.instagram && (
        <a href={`https://instagram.com/${artist.instagram}`} target="_blank" rel="noopener" className="text-[14px] text-gold-deep hover:underline">
          @{artist.instagram}
        </a>
      )}
      <div className="mt-3">
        <RequestCta preset={{ artistSlug: artist.slug ?? undefined }} label={`Ask for ${first}`} variant="secondary" className="h-11! w-full md:h-11!" />
      </div>
    </article>
  );
}
