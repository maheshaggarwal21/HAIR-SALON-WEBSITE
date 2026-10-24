/**
 * @file WebsiteOffers.tsx
 * @description Website offers (CF D29, T3.1 brought forward; website.manage).
 * The owner creates an offer with real start and end dates. While it runs, the
 * website shows a colourful bar above the header on every page and, if chosen,
 * a pop-up with a small poster. Nothing shows before the start date or after
 * the end date, and an offer can be paused without deleting it.
 *
 * An offer can also carry cheaper prices (D59): either single services at a lower
 * price, or bundles of services at one price. While the offer runs the website
 * shows the cheaper price with the normal price crossed out and the % off; the
 * booking engine charges the same cheaper price. Every amount is checked on the
 * server against the real menu price, so a price at or above normal is refused.
 *
 * An offer can also have its own PAGE (D62): /offers/<address>, and /offers/now while the
 * offer's dates contain today. The page has its own words, picture or reel, price line and the
 * services its booking form pre-selects. Visitors send a request (no payment, no code); the
 * price on the page is words, never applied: reception gives the discount by hand.
 *
 * Honesty (CLAUDE.md): the site shows the real end date. No fake countdowns or
 * "only N left", and a crossed-out price exists only inside the offer's dates.
 */

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Loader2, Megaphone, Pause, Pencil, Play, Plus, Save, Search, Trash2, X } from "lucide-react";
import MediaInput from "@/components/website/MediaInput";
import PosterReader from "@/components/website/PosterReader";

const API = import.meta.env.VITE_BACKEND_URL || "";

type Theme = "festive" | "rose" | "emerald" | "midnight";
type Status = "scheduled" | "live" | "ended" | "paused";

interface Offer {
  _id?: string;
  name: string;
  startDate: string;
  endDate: string;
  active: boolean;
  theme: Theme;
  showBar: boolean;
  showPopup: boolean;
  content: { eyebrow: string | null; headline: string; body: string | null; image: string | null; ctaLabel: string; ctaHref: string };
  popup: { delaySeconds: number; frequency: "session" | "day" };
  servicePrices: ServicePrice[];
  bundles: Bundle[];
  /** The offer's landing page. It exists once it has an address (slug). */
  page: OfferPage;
  status?: Status;
}

interface OfferPage {
  slug: string | null;
  headline: string | null;
  offerText: string | null;
  price: number | null;
  priceNote: string | null;
  /** Kept in step with images[0]; older offers only have this one. */
  image: string | null;
  /** Up to 5 pictures or posters, shown as a slideshow on the page, in this order (D63). */
  images: string[];
  reelId: string | null;
  serviceIds: string[];
}
interface ReelRow {
  _id: string;
  caption?: string | null;
  mediaType?: string;
}

const blankPage = (): OfferPage => ({ slug: null, headline: null, offerText: null, price: null, priceNote: null, image: null, images: [], reelId: null, serviceIds: [] });
const slugify = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
const SITE = "https://www.thexpertshair.com";
const MAX_PICTURES = 5;

interface ServicePrice {
  serviceId: string;
  price: number;
}
interface Bundle {
  /** Set by the server on first save; sent back so an edit keeps the bundle's web address. */
  slug?: string;
  name: string;
  description: string | null;
  audience: "her" | "him" | "unisex";
  serviceIds: string[];
  price: number;
}
interface MenuService {
  _id: string;
  name: string;
  publicName?: string | null;
  publicPrice?: number | null;
  audience?: string | null;
}

/** Preview colours. Mirror customer/app/globals.css `.offer-theme-*`. */
const THEMES: { key: Theme; label: string; a: string; b: string; glow: string }[] = [
  { key: "festive", label: "Festive maroon", a: "#5c0b26", b: "#9d1747", glow: "#f2c66d" },
  { key: "rose", label: "Rose", a: "#8a1846", b: "#b62a63", glow: "#ffd3e3" },
  { key: "emerald", label: "Emerald", a: "#08402f", b: "#0f6e50", glow: "#f2c66d" },
  { key: "midnight", label: "Midnight", a: "#17153a", b: "#3b2d78", glow: "#f2c66d" },
];

const STATUS_STYLE: Record<Status, string> = {
  live: "bg-emerald-100 text-emerald-800",
  scheduled: "bg-amber-100 text-amber-800",
  paused: "bg-stone-200 text-stone-700",
  ended: "bg-stone-100 text-stone-500",
};
const STATUS_LABEL: Record<Status, string> = { live: "Live now", scheduled: "Scheduled", paused: "Paused", ended: "Ended" };

const todayIST = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
const nice = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

const blank = (): Offer => ({
  name: "",
  startDate: todayIST(),
  endDate: todayIST(),
  active: true,
  theme: "festive",
  showBar: true,
  showPopup: true,
  content: { eyebrow: "Festive offer", headline: "", body: null, image: null, ctaLabel: "See the offer", ctaHref: "/services" },
  popup: { delaySeconds: 6, frequency: "day" },
  servicePrices: [],
  bundles: [],
  page: blankPage(),
});

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}/api/website${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const d = await res.json();
  if (!res.ok) throw new Error(d.error || "Request failed");
  return d as T;
}

const inputClass =
  "w-full h-11 px-4 rounded-xl border border-stone-200 bg-stone-50 text-stone-900 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400/50 focus:border-amber-400 placeholder:text-stone-400";
const labelClass = "block text-xs font-semibold text-stone-600 mb-1.5 uppercase tracking-wider";

const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;
const pctOff = (regular: number, price: number) => (regular > 0 && price < regular ? Math.round((1 - price / regular) * 100) : 0);
const nameOf = (s: MenuService) => s.publicName || s.name;

/** Type a few letters, tap a service. Hides the ones already chosen. */
function ServicePicker({ menu, taken, onPick, label }: { menu: MenuService[]; taken: Set<string>; onPick: (id: string) => void; label: string }) {
  const [q, setQ] = useState("");
  const hits = q.trim()
    ? menu.filter((s) => !taken.has(s._id) && `${s.name} ${s.publicName ?? ""}`.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8)
    : [];
  return (
    <div className="relative">
      <Search className="absolute left-3.5 top-3.5 w-4 h-4 text-stone-400" />
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={label} className={`${inputClass} pl-10`} />
      {hits.length > 0 && (
        <ul className="absolute z-10 mt-1 w-full rounded-xl border border-stone-200 bg-white shadow-lg overflow-hidden">
          {hits.map((s) => (
            <li key={s._id}>
              <button
                type="button"
                onClick={() => {
                  onPick(s._id);
                  setQ("");
                }}
                className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-sm text-left hover:bg-amber-50"
              >
                <span className="text-stone-900">{nameOf(s)}</span>
                <span className="text-stone-500 tabular-nums">{rupees(s.publicPrice ?? 0)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** What the customer will see for one price, so the owner can judge it. */
function PricePreview({ regular, price }: { regular: number; price: number }) {
  const pct = pctOff(regular, price);
  if (!price) return <span className="text-xs text-stone-400">Enter the offer price</span>;
  if (!pct) return <span className="text-xs font-medium text-red-600">Must be below {rupees(regular)}</span>;
  return (
    <span className="text-sm">
      <s className="text-stone-400">{rupees(regular)}</s> <b className="text-stone-900">{rupees(price)}</b> <span className="text-xs text-emerald-700 font-semibold">{pct}% off</span>
    </span>
  );
}

function PricesEditor({ offer, menu, onChange }: { offer: Offer; menu: MenuService[]; onChange: (patch: Partial<Offer>) => void }) {
  const byId = new Map(menu.map((s) => [s._id, s]));
  const priced = new Set(offer.servicePrices.map((p) => p.serviceId));

  const setPrice = (i: number, price: number) => onChange({ servicePrices: offer.servicePrices.map((p, j) => (j === i ? { ...p, price } : p)) });
  const setBundle = (i: number, patch: Partial<Bundle>) => onChange({ bundles: offer.bundles.map((b, j) => (j === i ? { ...b, ...patch } : b)) });

  return (
    <div className="space-y-6 border-t border-stone-100 pt-5">
      <div>
        <h4 className="font-semibold text-stone-900">Cheaper prices for single services</h4>
        <p className="text-sm text-stone-500 mt-1">
          Pick a service and set its offer price. While the offer runs, the website shows the offer price with the normal price crossed out and the % off, and online bookings are charged the offer price.
        </p>
        <div className="mt-3 space-y-2">
          {offer.servicePrices.map((p, i) => {
            const svc = byId.get(p.serviceId);
            const regular = svc?.publicPrice ?? 0;
            return (
              <div key={p.serviceId} className="rounded-xl border border-stone-200 bg-stone-50 p-3 flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1 basis-48">
                  <div className="font-medium text-stone-900 truncate">{svc ? nameOf(svc) : "Service not on the menu any more"}</div>
                  <div className="text-xs text-stone-500">Normal price {rupees(regular)}</div>
                </div>
                <label className="flex items-center gap-1.5 text-sm text-stone-600">
                  Offer ₹
                  <input type="number" min={1} max={Math.max(regular - 1, 1)} value={p.price || ""} onChange={(e) => setPrice(i, Math.floor(Number(e.target.value) || 0))} className={`${inputClass} w-24`} />
                </label>
                <label className="flex items-center gap-1.5 text-sm text-stone-600">
                  or
                  <input
                    type="number"
                    min={1}
                    max={99}
                    value={pctOff(regular, p.price) || ""}
                    onChange={(e) => {
                      const pct = Math.min(99, Math.max(0, Number(e.target.value) || 0));
                      setPrice(i, pct ? Math.max(1, Math.round(regular * (1 - pct / 100))) : 0);
                    }}
                    className={`${inputClass} w-20`}
                  />
                  % off
                </label>
                <div className="basis-full sm:basis-auto sm:min-w-44 text-right">
                  <PricePreview regular={regular} price={p.price} />
                </div>
                <button type="button" onClick={() => onChange({ servicePrices: offer.servicePrices.filter((_, j) => j !== i) })} aria-label="Remove price" className="h-9 w-9 inline-flex items-center justify-center rounded-lg text-stone-400 hover:bg-stone-100 hover:text-red-600">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            );
          })}
        </div>
        <div className="mt-3 max-w-md">
          <ServicePicker menu={menu} taken={priced} label="Add a service: type its name" onPick={(id) => onChange({ servicePrices: [...offer.servicePrices, { serviceId: id, price: 0 }] })} />
        </div>
      </div>

      <div>
        <h4 className="font-semibold text-stone-900">Bundles</h4>
        <p className="text-sm text-stone-500 mt-1">
          Several services sold together at one lower price. The website lists the bundle with what is in it and the total if booked separately, and the customer books and pays for it in one go.
        </p>
        <div className="mt-3">
          <PosterReader
            menu={menu}
            onAddBundles={(more) => onChange({ bundles: [...offer.bundles, ...more] })}
            canAddPicture={offer.page?.slug != null && (offer.page.images?.length ?? 0) < MAX_PICTURES}
            onAddPicture={(url) => onChange({ page: { ...(offer.page ?? blankPage()), images: [...(offer.page?.images ?? []), url] } })}
          />
        </div>
        <div className="mt-3 space-y-3">
          {offer.bundles.map((b, i) => {
            const items = b.serviceIds.map((id) => byId.get(id));
            const total = items.reduce((sum, s) => sum + (s?.publicPrice ?? 0), 0);
            return (
              <div key={b.slug ?? i} className="rounded-xl border border-stone-200 bg-stone-50 p-4 space-y-3">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="flex-1 basis-56">
                    <label className={labelClass}>Bundle name</label>
                    <input value={b.name} onChange={(e) => setBundle(i, { name: e.target.value })} maxLength={60} placeholder="e.g. Cut + wash + blow dry" className={inputClass} />
                  </div>
                  <div>
                    <label className={labelClass}>For</label>
                    <select value={b.audience} onChange={(e) => setBundle(i, { audience: e.target.value as Bundle["audience"] })} className={`${inputClass} w-32`}>
                      <option value="unisex">Everyone</option>
                      <option value="her">Women</option>
                      <option value="him">Men</option>
                    </select>
                  </div>
                  <button type="button" onClick={() => onChange({ bundles: offer.bundles.filter((_, j) => j !== i) })} aria-label="Remove bundle" className="mt-6 h-9 w-9 inline-flex items-center justify-center rounded-lg text-stone-400 hover:bg-stone-100 hover:text-red-600">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                <input value={b.description ?? ""} onChange={(e) => setBundle(i, { description: e.target.value || null })} maxLength={160} placeholder="One line about it (optional)" className={inputClass} />
                <div className="flex flex-wrap gap-2">
                  {b.serviceIds.map((id) => {
                    const s = byId.get(id);
                    return (
                      <span key={id} className="inline-flex items-center gap-1.5 rounded-full bg-white border border-stone-200 pl-3 pr-1.5 py-1 text-sm">
                        {s ? `${nameOf(s)} · ${rupees(s.publicPrice ?? 0)}` : "Removed service"}
                        <button type="button" onClick={() => setBundle(i, { serviceIds: b.serviceIds.filter((x) => x !== id) })} aria-label="Remove from bundle" className="h-6 w-6 inline-flex items-center justify-center rounded-full text-stone-400 hover:bg-stone-100">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </span>
                    );
                  })}
                </div>
                <div className="max-w-md">
                  <ServicePicker menu={menu} taken={new Set(b.serviceIds)} label="Add a service to this bundle" onPick={(id) => setBundle(i, { serviceIds: [...b.serviceIds, id] })} />
                </div>
                <div className="flex flex-wrap items-center gap-4">
                  <label className="flex items-center gap-1.5 text-sm text-stone-600">
                    Bundle price ₹
                    <input type="number" min={1} value={b.price || ""} onChange={(e) => setBundle(i, { price: Math.floor(Number(e.target.value) || 0) })} className={`${inputClass} w-28`} />
                  </label>
                  <span className="text-sm text-stone-500">Separately {rupees(total)}</span>
                  <PricePreview regular={total} price={b.price} />
                </div>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => onChange({ bundles: [...offer.bundles, { name: "", description: null, audience: "unisex", serviceIds: [], price: 0 }] })}
          className="mt-3 inline-flex items-center gap-1.5 h-10 px-4 rounded-lg border border-stone-200 bg-white text-sm font-semibold text-stone-800 hover:bg-stone-50"
        >
          <Plus className="w-4 h-4" /> New bundle
        </button>
      </div>
    </div>
  );
}

/** What stops the offer being saved, in plain words (the server checks again). */
/**
 * One new picture: upload it or paste its link, then press Add. It is added only on the button,
 * so typing a link letter by letter never adds half a link.
 */
function AddPicture({ label, onAdd }: { label: string; onAdd: (url: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const ok = Boolean(draft && /^https:\/\/\S+$/.test(draft));
  return (
    <div className="mt-2 rounded-xl border border-dashed border-stone-300 p-3 space-y-2">
      <MediaInput label={label} folder="offers" value={draft} onChange={setDraft} hint="A wide or tall poster both work. The whole picture is shown, nothing is cropped." />
      <button
        type="button"
        disabled={!ok}
        onClick={() => {
          if (draft) onAdd(draft);
          setDraft(null);
        }}
        className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-stone-900 text-white text-xs font-semibold disabled:opacity-40 hover:bg-stone-800"
      >
        <Plus className="w-3.5 h-3.5" /> Add picture
      </button>
    </div>
  );
}

/** A copy of the list with one item moved from one place to another. */
function move<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** The offer's own page: address, words, pictures or reel, price line and the services to pre-select. */
function OfferPageEditor({ offer, menu, reels, onChange }: { offer: Offer; menu: MenuService[]; reels: ReelRow[]; onChange: (patch: Partial<Offer>) => void }) {
  const page = offer.page ?? blankPage();
  const on = page.slug !== null;
  const setPage = (patch: Partial<OfferPage>) => onChange({ page: { ...page, ...patch } });
  const byId = new Map(menu.map((s) => [s._id, s]));
  const slug = page.slug ?? "";
  return (
    <div className="rounded-xl border border-stone-200 p-4 space-y-4">
      <label className="flex items-start gap-2 text-sm text-stone-800">
        <input
          type="checkbox"
          className="mt-1"
          checked={on}
          onChange={(e) => onChange({ page: e.target.checked ? { ...page, slug: slugify(offer.name) || "offer", headline: page.headline ?? (offer.content.headline || null) } : { ...page, slug: null } })}
        />
        <span>
          <span className="font-semibold">Give this offer its own page</span>
          <span className="block text-xs text-stone-500">For ads and WhatsApp links. Visitors pick a day and time and send a request; nothing is paid and no code is needed.</span>
        </span>
      </label>

      {on && (
        <div className="space-y-4">
          <div>
            <label className={labelClass}>Page address</label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-stone-500 whitespace-nowrap">…/offers/</span>
              <input value={slug} onChange={(e) => setPage({ slug: slugify(e.target.value) })} maxLength={60} placeholder="karwa" className={inputClass} />
            </div>
            {slug.length >= 3 && (
              <div className="mt-2 space-y-0.5 text-xs text-stone-500">
                <div>
                  This offer's page: <span className="select-all font-mono text-stone-700">{SITE}/offers/{slug}</span>
                </div>
                <div>
                  Whatever offer is on today: <span className="select-all font-mono text-stone-700">{SITE}/offers/now</span>
                </div>
              </div>
            )}
          </div>

          <div>
            <label className={labelClass}>Headline on the page</label>
            <input value={page.headline ?? ""} onChange={(e) => setPage({ headline: e.target.value || null })} maxLength={90} className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>What the offer is</label>
            <textarea value={page.offerText ?? ""} onChange={(e) => setPage({ offerText: e.target.value || null })} maxLength={500} rows={3} className={`${inputClass} h-auto py-3`} placeholder="e.g. A hair spa and a blow dry, done in an hour." />
          </div>
          <div className="grid sm:grid-cols-[10rem_1fr] gap-3">
            <div>
              <label className={labelClass}>Price (₹)</label>
              <input
                type="number"
                min={1}
                value={page.price ?? ""}
                onChange={(e) => setPage({ price: e.target.value ? Math.round(Number(e.target.value)) : null })}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Beside the price</label>
              <input value={page.priceNote ?? ""} onChange={(e) => setPage({ priceNote: e.target.value || null })} maxLength={60} placeholder="for both, per person…" className={inputClass} />
            </div>
          </div>
          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            This price is shown on the page and recorded with the request. It is <b>not applied</b> to anything: the receptionist gives the discount by hand when she bills.
          </p>

          <div>
            <label className={labelClass}>Pictures and posters (up to {MAX_PICTURES})</label>
            <p className="text-xs text-stone-500 mb-2">They play as a slideshow at the top of the page, in this order. Visitors can swipe through them.</p>
            <ul className="space-y-2">
              {page.images.map((u, i) => (
                <li key={`${u}-${i}`} className="flex flex-wrap items-center gap-3 rounded-xl border border-stone-200 bg-stone-50 p-2.5">
                  <img src={u} alt="" className="h-14 w-11 shrink-0 rounded-md object-cover border border-stone-200 bg-stone-100" />
                  <div className="min-w-0 flex-1 basis-40">
                    <div className="text-xs font-semibold text-stone-700">Picture {i + 1}</div>
                    <div className="truncate text-[11px] text-stone-500">{u}</div>
                  </div>
                  <div className="flex gap-1.5">
                    <button type="button" disabled={i === 0} onClick={() => setPage({ images: move(page.images, i, i - 1) })} className="h-8 px-2.5 rounded-lg border border-stone-200 bg-white text-xs font-semibold text-stone-700 disabled:opacity-30 hover:bg-stone-50">
                      Earlier
                    </button>
                    <button type="button" disabled={i === page.images.length - 1} onClick={() => setPage({ images: move(page.images, i, i + 1) })} className="h-8 px-2.5 rounded-lg border border-stone-200 bg-white text-xs font-semibold text-stone-700 disabled:opacity-30 hover:bg-stone-50">
                      Later
                    </button>
                    <button type="button" aria-label={`Remove picture ${i + 1}`} onClick={() => setPage({ images: page.images.filter((_, j) => j !== i) })} className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-stone-400 hover:bg-white hover:text-red-600">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            {page.images.length < MAX_PICTURES && <AddPicture label={page.images.length ? "Add another picture" : "Add a picture"} onAdd={(u) => setPage({ images: [...page.images, u] })} />}
          </div>
          <div>
            <label className={labelClass}>Start the slideshow with one of your Instagram reels (optional)</label>
            <select value={page.reelId ?? ""} onChange={(e) => setPage({ reelId: e.target.value || null })} className={inputClass}>
              <option value="">No reel</option>
              {reels.map((r) => (
                <option key={r._id} value={r._id}>
                  {(r.caption || "Untitled reel").slice(0, 70)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={labelClass}>Services the booking form selects</label>
            {page.serviceIds.length === 0 && <p className="text-xs text-red-600 mb-2">Add at least one service. The form books exactly these.</p>}
            <ul className="space-y-1.5 mb-2">
              {page.serviceIds.map((id) => (
                <li key={id} className="flex items-center justify-between gap-3 rounded-lg bg-stone-50 border border-stone-200 px-3 py-2 text-sm">
                  <span className="text-stone-900">{byId.has(id) ? nameOf(byId.get(id)!) : "A service no longer on the menu"}</span>
                  <button type="button" onClick={() => setPage({ serviceIds: page.serviceIds.filter((x) => x !== id) })} aria-label="Remove service" className="text-stone-400 hover:text-red-600">
                    <X className="w-4 h-4" />
                  </button>
                </li>
              ))}
            </ul>
            <ServicePicker menu={menu} taken={new Set(page.serviceIds)} label="Add a service: type its name" onPick={(id) => setPage({ serviceIds: [...page.serviceIds, id] })} />
          </div>
        </div>
      )}
    </div>
  );
}

function priceProblem(o: Offer, menu: MenuService[]): string | null {
  const byId = new Map(menu.map((s) => [s._id, s]));
  for (const p of o.servicePrices) {
    const s = byId.get(p.serviceId);
    if (!s) return "One priced service is not on the website menu any more. Remove it.";
    if (!(p.price >= 1 && p.price < (s.publicPrice ?? 0))) return `${nameOf(s)}: set an offer price below ${rupees(s.publicPrice ?? 0)}.`;
  }
  for (const b of o.bundles) {
    if (!b.name.trim()) return "Give each bundle a name.";
    if (b.serviceIds.length < 2) return `${b.name}: add at least two services.`;
    const total = b.serviceIds.reduce((sum, id) => sum + (byId.get(id)?.publicPrice ?? 0), 0);
    if (b.serviceIds.some((id) => !byId.has(id))) return `${b.name}: a service is not on the menu any more.`;
    if (!(b.price >= 1 && b.price < total)) return `${b.name}: set a price below ${rupees(total)}.`;
  }
  if (o.page?.slug !== null && o.page?.slug !== undefined) {
    if (o.page.slug.length < 3) return "The page address needs at least 3 letters or numbers.";
    if (o.page.serviceIds.length === 0) return "The offer page needs at least one service to pre-select.";
    if (o.page.serviceIds.some((id) => !byId.has(id))) return "A service on the offer page is not on the website menu any more. Remove it.";
  }
  return null;
}

export default function WebsiteOffers() {
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [editing, setEditing] = useState<Offer | null>(null);
  const [menu, setMenu] = useState<MenuService[]>([]);
  const [reels, setReels] = useState<ReelRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  /** Deleting is permanent, so the bin asks once more. */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = () =>
    api<Offer[]>("/campaigns")
      .then(setOffers)
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
    api<MenuService[]>("/services")
      .then((all) => setMenu(all.filter((s) => s.publicPrice != null).sort((a, b) => nameOf(a).localeCompare(nameOf(b)))))
      .catch((e) => setError(e.message));
    api<ReelRow[]>("/reels")
      .then((r) => setReels(Array.isArray(r) ? r : []))
      .catch(() => setReels([]));
  }, []);

  async function save() {
    if (!editing) return;
    setSaving(true);
    setError("");
    try {
      const { _id, name, startDate, endDate, active, theme, showBar, showPopup, content, popup, servicePrices, bundles, page } = editing;
      const body = { name, startDate, endDate, active, theme, showBar, showPopup, content, popup, servicePrices, bundles, page: { ...page, image: page.images?.[0] ?? null } };
      await api(_id ? `/campaigns/${_id}` : "/campaigns", { method: _id ? "PATCH" : "POST", body: JSON.stringify(body) });
      setEditing(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function togglePause(o: Offer) {
    try {
      await api(`/campaigns/${o._id}`, { method: "PATCH", body: JSON.stringify({ active: !o.active }) });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update");
    }
  }

  async function remove(id: string) {
    try {
      await api(`/campaigns/${id}`, { method: "DELETE" });
      setConfirmDelete(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete");
    }
  }

  const set = (patch: Partial<Offer>) => editing && setEditing({ ...editing, ...patch });
  const setContent = (patch: Partial<Offer["content"]>) => editing && setEditing({ ...editing, content: { ...editing.content, ...patch } });
  const theme = THEMES.find((t) => t.key === editing?.theme) ?? THEMES[0];
  const problem = editing ? priceProblem(editing, menu) : null;

  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }} className="max-w-3xl">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-stone-900 flex items-center gap-2">
            <Megaphone className="w-6 h-6 text-amber-500" /> Website Offers
          </h2>
          <p className="text-sm text-stone-500 mt-1">
            While an offer runs, the website shows a colourful bar on every page and, if you want, a pop-up with your poster. An offer can
            also give single services a cheaper price, or sell several services together as a bundle. It all switches on and off by itself on
            the dates you choose (Patiala time).
          </p>
        </div>
        {!editing && (
          <button
            onClick={() => setEditing(blank())}
            className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg bg-stone-900 text-white text-sm font-semibold hover:bg-stone-800"
          >
            <Plus className="w-4 h-4" /> New offer
          </button>
        )}
      </div>

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

      {editing && (
        <section className="bg-white rounded-xl border border-stone-200/80 shadow-sm p-5 mb-6 space-y-5">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-stone-900">{editing._id ? "Edit offer" : "New offer"}</h3>
            <button onClick={() => setEditing(null)} aria-label="Close editor" className="h-9 w-9 inline-flex items-center justify-center rounded-lg text-stone-400 hover:bg-stone-100">
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Live preview of the bar */}
          <div>
            <span className={labelClass}>Preview</span>
            <div
              className="rounded-lg px-4 py-2.5 text-white text-sm flex items-center gap-3 overflow-hidden"
              style={{ background: `linear-gradient(110deg, ${theme.a}, ${theme.b} 45%, ${theme.a})` }}
            >
              <span className="h-2 w-2 rounded-full shrink-0" style={{ background: theme.glow }} />
              {editing.content.eyebrow && (
                <span className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider shrink-0" style={{ background: theme.glow, color: theme.a }}>
                  {editing.content.eyebrow}
                </span>
              )}
              <span className="font-semibold truncate">{editing.content.headline || "Your headline"}</span>
              <span className="ml-auto shrink-0 opacity-90 hidden sm:inline">
                Till {nice(editing.endDate)} · {editing.content.ctaLabel || "See the offer"} →
              </span>
            </div>
          </div>

          <div className="grid sm:grid-cols-3 gap-3">
            <div className="sm:col-span-3">
              <label className={labelClass}>Offer name (only staff see this)</label>
              <input value={editing.name} onChange={(e) => set({ name: e.target.value })} maxLength={80} placeholder="e.g. Karva Chauth 2026" className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Starts</label>
              <input type="date" value={editing.startDate} onChange={(e) => set({ startDate: e.target.value })} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Ends (last day)</label>
              <input type="date" value={editing.endDate} min={editing.startDate} onChange={(e) => set({ endDate: e.target.value })} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Colour</label>
              <div className="flex gap-2 h-11 items-center">
                {THEMES.map((t) => (
                  <button
                    key={t.key}
                    onClick={() => set({ theme: t.key })}
                    aria-label={t.label}
                    aria-pressed={editing.theme === t.key}
                    title={t.label}
                    className={`h-9 w-9 rounded-full border-2 ${editing.theme === t.key ? "border-stone-900" : "border-transparent"}`}
                    style={{ background: `linear-gradient(135deg, ${t.a}, ${t.b})` }}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="grid sm:grid-cols-3 gap-3">
            <div>
              <label className={labelClass}>Small label</label>
              <input value={editing.content.eyebrow ?? ""} onChange={(e) => setContent({ eyebrow: e.target.value || null })} maxLength={30} placeholder="Festive offer" className={inputClass} />
            </div>
            <div className="sm:col-span-2">
              <label className={labelClass}>Headline</label>
              <input value={editing.content.headline} onChange={(e) => setContent({ headline: e.target.value })} maxLength={90} placeholder="Karva Chauth glow: hair, skin and makeup for ₹2,500" className={inputClass} />
            </div>
            <div className="sm:col-span-3">
              <label className={labelClass}>Details (pop-up only, optional)</label>
              <textarea
                value={editing.content.body ?? ""}
                onChange={(e) => setContent({ body: e.target.value || null })}
                maxLength={220}
                rows={2}
                placeholder="What's included, who it's for"
                className="w-full px-4 py-2.5 rounded-xl border border-stone-200 bg-stone-50 text-sm"
              />
            </div>
            <div>
              <label className={labelClass}>Button text</label>
              <input value={editing.content.ctaLabel} onChange={(e) => setContent({ ctaLabel: e.target.value })} maxLength={30} className={inputClass} />
            </div>
            <div className="sm:col-span-2">
              <label className={labelClass}>Button goes to</label>
              <input list="offer-links" value={editing.content.ctaHref} onChange={(e) => setContent({ ctaHref: e.target.value })} placeholder="/offers/karva-chauth" className={inputClass} />
              <datalist id="offer-links">
                <option value="/offers/karva-chauth">Karva Chauth page</option>
                <option value="/services">Full menu</option>
                <option value="/services?for=her">Menu: for her</option>
                <option value="/services?for=him">Menu: for him</option>
              </datalist>
            </div>
          </div>

          <MediaInput
            label="Pop-up poster (optional)"
            folder="offers"
            value={editing.content.image}
            onChange={(u) => setContent({ image: u })}
            hint="Upright or square image. Without a poster the pop-up uses the offer colour with your headline."
          />

          <div className="flex flex-wrap gap-x-6 gap-y-3 text-sm text-stone-700">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={editing.showBar} onChange={(e) => set({ showBar: e.target.checked })} /> Show the bar on every page
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={editing.showPopup} onChange={(e) => set({ showPopup: e.target.checked })} /> Show a pop-up
            </label>
          </div>

          {editing.showPopup && (
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>Pop-up appears after (seconds)</label>
                <input
                  type="number"
                  min={5}
                  max={60}
                  value={editing.popup.delaySeconds}
                  onChange={(e) => set({ popup: { ...editing.popup, delaySeconds: Math.min(60, Math.max(5, Number(e.target.value) || 5)) } })}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Show the pop-up</label>
                <select
                  value={editing.popup.frequency}
                  onChange={(e) => set({ popup: { ...editing.popup, frequency: e.target.value as "session" | "day" } })}
                  className={inputClass}
                >
                  <option value="day">Once a day per visitor</option>
                  <option value="session">Once per visit</option>
                </select>
              </div>
            </div>
          )}

          <PricesEditor offer={editing} menu={menu} onChange={set} />

          <OfferPageEditor offer={editing} menu={menu} reels={reels} onChange={set} />

          {problem && <p className="text-sm text-red-600">{problem}</p>}

          <div className="flex justify-end gap-2">
            <button onClick={() => setEditing(null)} className="h-10 px-4 rounded-lg border border-stone-200 text-sm text-stone-700 hover:bg-stone-50">
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving || Boolean(problem) || !editing.name.trim() || !editing.content.headline.trim() || !editing.content.ctaHref.trim()}
              className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg bg-stone-900 text-white text-sm font-semibold hover:bg-stone-800 disabled:opacity-40"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save offer
            </button>
          </div>
        </section>
      )}

      {!offers ? (
        !error && (
          <div className="flex justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-stone-400" />
          </div>
        )
      ) : offers.length === 0 ? (
        <p className="text-sm text-stone-500">No offers yet. Create one and it appears on the website on its start date.</p>
      ) : (
        <div className="space-y-3">
          {offers.map((o) => {
            const t = THEMES.find((x) => x.key === o.theme) ?? THEMES[0];
            return (
              <div key={o._id} className="bg-white rounded-xl border border-stone-200/80 shadow-sm p-4 flex flex-wrap items-center gap-3">
                <span className="h-10 w-10 rounded-lg shrink-0" style={{ background: `linear-gradient(135deg, ${t.a}, ${t.b})` }} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-stone-900">{o.name}</span>
                    {o.status && <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_STYLE[o.status]}`}>{STATUS_LABEL[o.status]}</span>}
                  </div>
                  <p className="text-sm text-stone-500 truncate">
                    {nice(o.startDate)} – {nice(o.endDate)} · {[o.showBar && "bar", o.showPopup && "pop-up", o.servicePrices?.length > 0 && `${o.servicePrices.length} cheaper price${o.servicePrices.length > 1 ? "s" : ""}`, o.bundles?.length > 0 && `${o.bundles.length} bundle${o.bundles.length > 1 ? "s" : ""}`, o.page?.slug && `page /offers/${o.page.slug}`].filter(Boolean).join(" + ") || "hidden"} · {o.content.headline}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => setEditing({ ...o, servicePrices: o.servicePrices ?? [], bundles: o.bundles ?? [], page: { ...blankPage(), ...(o.page ?? {}), images: o.page?.images?.length ? o.page.images : o.page?.image ? [o.page.image] : [], serviceIds: (o.page?.serviceIds ?? []).map(String) } })} aria-label="Edit offer" className="h-10 w-10 inline-flex items-center justify-center rounded-lg text-stone-500 hover:bg-stone-100">
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => togglePause(o)}
                    aria-label={o.active ? "Pause offer" : "Resume offer"}
                    title={o.active ? "Pause" : "Resume"}
                    className="h-10 w-10 inline-flex items-center justify-center rounded-lg text-stone-500 hover:bg-stone-100"
                  >
                    {o.active ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                  </button>
                  {confirmDelete === o._id ? (
                    <button onClick={() => remove(o._id!)} className="h-10 px-3 rounded-lg bg-red-600 text-white text-sm font-semibold">
                      Delete?
                    </button>
                  ) : (
                    <button onClick={() => setConfirmDelete(o._id!)} aria-label="Delete offer" className="h-10 w-10 inline-flex items-center justify-center rounded-lg text-stone-400 hover:bg-stone-100 hover:text-red-600">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </motion.div>
  );
}
