"use client";

/**
 * Public menu (DS §6.2 `/services`): For her / For him / Everyone tabs, category chips,
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

type Tab = "her" | "him" | "all";
const TABS: [Tab, string][] = [
  ["her", "For her"],
  ["him", "For him"],
  ["all", "Everyone"],
];

export function MenuBrowser({ her, him, all }: { her: Card[]; him: Card[]; all: Card[] }) {
  const [tab, setTab] = useState<Tab>("her");
  const [category, setCategory] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const showTab = useCallback((t: Tab) => {
    setTab(t);
    setCategory(null);
  }, []);

  const choose = (t: Tab) => {
    showTab(t);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("for", t);
      window.history.replaceState(null, "", url);
    } catch {
      /* URL update is a nicety */
    }
  };

  const list = tab === "her" ? her : tab === "him" ? him : all;
  const categories = useMemo(() => [...new Set(list.map((c) => c.displayCategory).filter(Boolean))] as string[], [list]);
  const needle = q.trim().toLowerCase();
  // A card is one of the owner's groups ("Waxing (honey)"), so search its options too:
  // "keratin" finds Hair treatments.
  const matches = (c: Card) =>
    [c.name, c.shortDescription ?? "", ...c.options.map((o) => o.label ?? "")].some((t) => t.toLowerCase().includes(needle));
  const shown = list.filter((c) => (!category || c.displayCategory === category) && (!needle || matches(c)));

  return (
    <div>
      <Suspense fallback={null}>
        <TabFromUrl onTab={showTab} />
      </Suspense>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-2" role="tablist" aria-label="Menu">
          {TABS.map(([t, label]) => (
            <Chip key={t} role="tab" aria-selected={tab === t} aria-pressed={undefined} selected={tab === t} onClick={() => choose(t)} className="h-11 px-5 text-[15px]">
              {label}
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

      {/* One grid in menu order (the API sorts by section, then the owner's order). Cards
          are the owner's groups, so a heading per section would mostly sit over one card. */}
      <div className="mt-10">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {shown.map((c) => (
            <div key={c.slug} className="flex flex-col">
              <ServiceCard service={c} showImage fill optionLimit={Infinity} />
              <div className="mt-2 flex items-center justify-between gap-3">
                <Link href={`/services/${c.slug}`} className="text-[14px] font-semibold text-ink-muted hover:text-ink">
                  Details →
                </Link>
                <RequestCta
                  preset={{ audience: tab === "all" ? (c.audience === "him" ? "him" : "her") : tab, optionIds: c.options.length === 1 ? [c.options[0].id] : [] }}
                  label="Request"
                  variant="secondary"
                  className="h-10! px-4! md:h-10!"
                />
              </div>
            </div>
          ))}
        </div>
        {!shown.length && <p className="text-[16px] text-ink-muted">Nothing matches “{q}”. Try another word, or message us.</p>}
      </div>
    </div>
  );
}

/** Mirrors `?for=her|him|all` into the tab whenever the URL changes. */
function TabFromUrl({ onTab }: { onTab: (t: Tab) => void }) {
  const f = useSearchParams().get("for");
  useEffect(() => {
    if (f === "her" || f === "him" || f === "all") onTab(f);
  }, [f, onTab]);
  return null;
}
