/** `/artists` — the team (DS §6.1 §6). Everyone active in the staff app, unless the owner hid them (K6). */

import type { Metadata } from "next";
import { getArtists } from "@/lib/api";
import { ArtistCard } from "@/components/site/ArtistCard";

export const metadata: Metadata = {
  title: "Our artists",
  description: "Meet the stylists and artists at The Experts, Patiala, and ask for the one you'd like.",
  alternates: { canonical: "/artists" },
};

export default async function ArtistsPage() {
  const artists = await getArtists();
  return (
    <main className="flex-1 bg-sand px-4 pb-28 pt-12 md:px-16 md:pb-32 md:pt-20">
      <div className="mx-auto max-w-site">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gold-deep md:text-[13px]">The team</p>
        <h1 className="mt-4 font-serif text-[44px] leading-none tracking-[-0.02em] md:text-[72px]">
          Meet the <em className="text-gold-deep">artists</em>.
        </h1>
        <p className="mt-6 max-w-[640px] text-[17px] leading-[1.6] text-ink-muted">
          Ask for someone on your request and we&apos;ll do our best to give you their time.
        </p>
        {artists && artists.length > 0 ? (
          <div className="mt-12 grid grid-cols-2 gap-x-4 gap-y-12 md:grid-cols-3 lg:grid-cols-4">
            {artists.map((a) => (
              <ArtistCard key={a.id} artist={a} />
            ))}
          </div>
        ) : (
          <p className="mt-12 text-[16px] text-ink-muted">The team couldn&apos;t load just now. Refresh in a minute.</p>
        )}
      </div>
    </main>
  );
}
