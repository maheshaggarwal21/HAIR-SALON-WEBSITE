"use client";

/**
 * Public menu (DS §6.2 `/services`): For her / For him tabs, category chips,
 * search. Both menus arrive prerendered; the tab follows `?for=` in the URL
 * and is written back so a shared link opens the same tab.
 *
 * The URL is read through `useSearchParams` inside its own Suspense boundary
 * (`TabFromUrl`, renders nothing), so the static HTML stays the same for every
 * visitor AND the tab follows every later change. Reading `location.search`
 * once on mount missed the header's "For her" / "For him" links: they change
 * only the query string, Next keeps this component mounted, and the tab stayed
 * on whatever was chosen first (owner review, 14 Oct 2026).
 */

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { ServiceCard as Card } from "@/lib/types";
import { Chip } from "@/components/ui/Chip";
import { ServiceCard } from "@/components/ui/ServiceCard";
import { RequestCta } from "@/components/request/RequestContext";

export function MenuBrowser({ her, him }: { her: Card[]; him: Card[] }) {
  const [tab, setTab] = useState<"her" | "him">("her");
  const [category, setCategory] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const showTab = useCallback((t: "her" | "him") => {
    setTab(t);
    setCategory(null);
  }, []);

  const choose = (t: "her" | "him") => {
    showTab(t);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("for", t);
      window.history.replaceState(null, "", url);
    } catch {
      /* URL update is a nicety */
    }
  };

  const list = tab === "her" ? her : him;
  const categories = useMemo(() => [...new Set(list.map((c) => c.displayCategory).filter(Boolean))] as string[], [list]);
  const needle = q.trim().toLowerCase();
  const shown = list.filter(
    (c) =>
      (!category || c.displayCategory === category) &&
      (!needle || c.name.toLowerCase().includes(needle) || (c.shortDescription ?? "").toLowerCase().includes(needle))
  );
  const grouped = categories
    .map((cat) => ({ cat, cards: shown.filter((c) => c.displayCategory === cat) }))
    .filter((g) => g.cards.length);
  const uncategorised = shown.filter((c) => !c.displayCategory);

  return (
    <div>
      <Suspense fallback={null}>
        <TabFromUrl onTab={showTab} />
      </Suspense>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-2" role="tablist" aria-label="Menu">
          {(["her", "him"] as const).map((t) => (
            <Chip key={t} role="tab" aria-selected={tab === t} aria-pressed={undefined} selected={tab === t} onClick={() => choose(t)} className="h-11 px-5 text-[15px]">
              {t === "her" ? "For her" : "For him"}
            </Chip>
          ))}
        </div>
        <label className="ml-auto w-full sm:w-72">
          <span className="sr-only">Search services</span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            type="search"
            placeholder="Search services"
            className="h-11 w-full rounded-full border border-line bg-ivory-2 px-5 text-[15px]"
          />
        </label>
      </div>

      {categories.length > 1 && (
        <div className="-mx-4 mt-5 flex gap-2 overflow-x-auto px-4 pb-1">
          <Chip selected={!category} onClick={() => setCategory(null)}>
            All
          </Chip>
          {categories.map((c) => (
            <Chip key={c} selected={category === c} onClick={() => setCategory(c)}>
              {c}
            </Chip>
          ))}
        </div>
      )}

      <div className="mt-10 space-y-14">
        {[...grouped, ...(uncategorised.length ? [{ cat: "More", cards: uncategorised }] : [])].map((g) => (
          <section key={g.cat} aria-labelledby={`cat-${g.cat}`}>
            <h2 id={`cat-${g.cat}`} className="font-serif text-[30px] leading-tight md:text-[40px]">
              {g.cat}
            </h2>
            <div className="mt-5 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {g.cards.map((c) => (
                <div key={c.slug} className="flex flex-col">
                  <ServiceCard service={c} />
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <Link href={`/services/${c.slug}`} className="text-[14px] font-semibold text-ink-muted hover:text-ink">
                      Details →
                    </Link>
                    <RequestCta
                      preset={{ audience: tab, optionIds: c.options.length === 1 ? [c.options[0].id] : [] }}
                      label="Request"
                      variant="secondary"
                      className="h-10! px-4! md:h-10!"
                    />
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
        {!shown.length && <p className="text-[16px] text-ink-muted">Nothing matches “{q}”. Try another word, or message us.</p>}
      </div>
    </div>
  );
}

/** Mirrors `?for=her|him` into the tab whenever the URL changes. */
function TabFromUrl({ onTab }: { onTab: (t: "her" | "him") => void }) {
  const f = useSearchParams().get("for");
  useEffect(() => {
    if (f === "her" || f === "him") onTab(f);
  }, [f, onTab]);
  return null;
}
